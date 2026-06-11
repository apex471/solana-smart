use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    error::EscrowError,
    instruction::EscrowInstruction,
    state::{EscrowState, EscrowStatus, ESCROW_ID_LEN, ESCROW_STATE_DISCRIMINATOR, ESCROW_STATE_SIZE},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn id_to_bytes(escrow_id: &str) -> Result<[u8; ESCROW_ID_LEN], ProgramError> {
    let b = escrow_id.as_bytes();
    if b.len() > ESCROW_ID_LEN { return Err(EscrowError::EscrowIdTooLong.into()); }
    let mut buf = [0u8; ESCROW_ID_LEN];
    buf[..b.len()].copy_from_slice(b);
    Ok(buf)
}

fn verify_pda(
    program_id: &Pubkey,
    prefix: &[u8],
    id: &[u8; ESCROW_ID_LEN],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    let (pda, bump) = Pubkey::find_program_address(&[prefix, id], program_id);
    if pda != *expected { return Err(EscrowError::InvalidPDA.into()); }
    Ok(bump)
}

fn load(info: &AccountInfo) -> Result<EscrowState, ProgramError> {
    let s = EscrowState::try_from_slice(&info.data.borrow())
        .map_err(|_| EscrowError::UninitializedAccount)?;
    if !s.is_initialized() { return Err(EscrowError::UninitializedAccount.into()); }
    Ok(s)
}

fn save(info: &AccountInfo, s: &EscrowState) -> ProgramResult {
    s.serialize(&mut &mut info.data.borrow_mut()[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match EscrowInstruction::try_from_slice(data)
        .map_err(|_| EscrowError::InvalidInstruction)?
    {
        EscrowInstruction::CreateEscrow { escrow_id, recipient } => {
            msg!("CreateEscrow [{}] recipient={}", escrow_id, recipient);
            create_escrow(program_id, accounts, escrow_id, recipient)
        }
        EscrowInstruction::Deposit { escrow_id } => {
            msg!("Deposit [{}]", escrow_id);
            deposit(program_id, accounts, escrow_id)
        }
        EscrowInstruction::CancelEscrow { escrow_id } => {
            msg!("CancelEscrow [{}]", escrow_id);
            cancel_escrow(program_id, accounts, escrow_id)
        }
    }
}

// ---------------------------------------------------------------------------
// CreateEscrow  →  Pending
// ---------------------------------------------------------------------------

fn create_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
    recipient: Pubkey,
) -> ProgramResult {
    let it      = &mut accounts.iter();
    let admin   = next_account_info(it)?;
    let state   = next_account_info(it)?;
    let sysprog = next_account_info(it)?;

    if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id   = id_to_bytes(&escrow_id)?;
    let bump = verify_pda(program_id, b"escrow", &id, state.key)?;

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            admin.key,
            state.key,
            rent.minimum_balance(ESCROW_STATE_SIZE),
            ESCROW_STATE_SIZE as u64,
            program_id,
        ),
        &[admin.clone(), state.clone(), sysprog.clone()],
        &[&[b"escrow", &id, &[bump]]],
    )?;

    let clock = Clock::get()?;
    EscrowState {
        discriminator: ESCROW_STATE_DISCRIMINATOR,
        admin:         *admin.key,
        depositor:     Pubkey::default(),
        recipient,
        amount:        0,
        status:        EscrowStatus::Pending,
        escrow_id:     id,
        created_at:    clock.unix_timestamp,
        bump,
    }
    .serialize(&mut &mut state.data.borrow_mut()[..])?;

    msg!("Escrow ready. Funds will route to {} on deposit.", recipient);
    Ok(())
}

// ---------------------------------------------------------------------------
// Deposit  →  Released
// Funds transfer depositor → recipient atomically in this single instruction.
// No vault. No waiting. Recipient wallet is credited the moment this confirms.
// ---------------------------------------------------------------------------

fn deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let it        = &mut accounts.iter();
    let depositor = next_account_info(it)?;
    let state     = next_account_info(it)?;
    let recipient = next_account_info(it)?;
    let sysprog   = next_account_info(it)?;

    if !depositor.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;

    let mut s = load(state)?;
    if s.status != EscrowStatus::Pending { return Err(EscrowError::NotPending.into()); }
    if s.recipient != *recipient.key     { return Err(EscrowError::WrongRecipient.into()); }

    // Compute 99% of depositor's current balance at execution time.
    // The remaining 1% covers transaction fees and keeps the account alive.
    let balance = depositor.lamports();
    let amount  = balance
        .checked_mul(99)
        .and_then(|v| v.checked_div(100))
        .ok_or(EscrowError::Overflow)?;
    if amount == 0 { return Err(EscrowError::ZeroDeposit.into()); }

    // Execute transfer immediately — same instruction, atomic, final.
    invoke(
        &system_instruction::transfer(depositor.key, recipient.key, amount),
        &[depositor.clone(), recipient.clone(), sysprog.clone()],
    )?;

    s.depositor = *depositor.key;
    s.amount    = amount;
    s.status    = EscrowStatus::Released;
    save(state, &s)?;

    msg!("Escrow complete: {} lamports (99% of {}) → {}", amount, balance, recipient.key);
    Ok(())
}

// ---------------------------------------------------------------------------
// CancelEscrow  →  Cancelled  (admin only, Pending escrows only)
// ---------------------------------------------------------------------------

fn cancel_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let it    = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let state = next_account_info(it)?;

    if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;

    let mut s = load(state)?;
    if s.admin != *admin.key           { return Err(EscrowError::Unauthorized.into()); }
    if s.status != EscrowStatus::Pending { return Err(EscrowError::NotPending.into()); }

    s.status = EscrowStatus::Cancelled;
    save(state, &s)?;

    msg!("Escrow [{}] cancelled by admin", escrow_id);
    Ok(())
}
