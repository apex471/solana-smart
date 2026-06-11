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

fn drain_vault(vault: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    let amount = vault.lamports();
    if amount == 0 { return Ok(()); }
    **vault.try_borrow_mut_lamports()? = vault.lamports().checked_sub(amount).ok_or(EscrowError::Overflow)?;
    **dest.try_borrow_mut_lamports()?  = dest.lamports().checked_add(amount).ok_or(EscrowError::Overflow)?;
    Ok(())
}

fn verify_pda(program_id: &Pubkey, prefix: &[u8], id: &[u8; ESCROW_ID_LEN], expected: &Pubkey) -> Result<u8, ProgramError> {
    let (pda, bump) = Pubkey::find_program_address(&[prefix, id], program_id);
    if pda != *expected { return Err(EscrowError::InvalidPDA.into()); }
    Ok(bump)
}

fn load(info: &AccountInfo) -> Result<EscrowState, ProgramError> {
    let s = EscrowState::try_from_slice(&info.data.borrow()).map_err(|_| EscrowError::UninitializedAccount)?;
    if !s.is_initialized() { return Err(EscrowError::UninitializedAccount.into()); }
    Ok(s)
}

fn save(info: &AccountInfo, s: &EscrowState) -> ProgramResult {
    s.serialize(&mut &mut info.data.borrow_mut()[..]).map_err(|_| ProgramError::InvalidAccountData)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match EscrowInstruction::try_from_slice(data).map_err(|_| EscrowError::InvalidInstruction)? {
        EscrowInstruction::CreateEscrow { escrow_id, recipient } => {
            msg!("CreateEscrow [{}]", escrow_id);
            create_escrow(program_id, accounts, escrow_id, recipient)
        }
        EscrowInstruction::Deposit { escrow_id, amount } => {
            msg!("Deposit [{}] {}", escrow_id, amount);
            deposit(program_id, accounts, escrow_id, amount)
        }
        EscrowInstruction::ClaimFunds { escrow_id } => {
            msg!("ClaimFunds [{}]", escrow_id);
            claim_funds(program_id, accounts, escrow_id)
        }
        EscrowInstruction::RaiseDispute { escrow_id } => {
            msg!("RaiseDispute [{}]", escrow_id);
            raise_dispute(program_id, accounts, escrow_id)
        }
        EscrowInstruction::ResolveDispute { escrow_id, release_to_recipient } => {
            msg!("ResolveDispute [{}] release={}", escrow_id, release_to_recipient);
            resolve_dispute(program_id, accounts, escrow_id, release_to_recipient)
        }
        EscrowInstruction::EmergencyRefund { escrow_id } => {
            msg!("EmergencyRefund [{}]", escrow_id);
            emergency_refund(program_id, accounts, escrow_id)
        }
    }
}

// ---------------------------------------------------------------------------
// CreateEscrow  →  Pending
// ---------------------------------------------------------------------------

fn create_escrow(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String, recipient: Pubkey) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin   = next_account_info(it)?;
    let state   = next_account_info(it)?;
    let vault   = next_account_info(it)?;
    let sysprog = next_account_info(it)?;

    if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id   = id_to_bytes(&escrow_id)?;
    let bump = verify_pda(program_id, b"escrow", &id, state.key)?;
    verify_pda(program_id, b"vault", &id, vault.key)?;

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(admin.key, state.key, rent.minimum_balance(ESCROW_STATE_SIZE), ESCROW_STATE_SIZE as u64, program_id),
        &[admin.clone(), state.clone(), sysprog.clone()],
        &[&[b"escrow", &id, &[bump]]],
    )?;

    let clock = Clock::get()?;
    EscrowState {
        discriminator: ESCROW_STATE_DISCRIMINATOR,
        admin:      *admin.key,
        depositor:  Pubkey::default(),
        recipient,
        amount:     0,
        status:     EscrowStatus::Pending,
        escrow_id:  id,
        created_at: clock.unix_timestamp,
        bump,
    }.serialize(&mut &mut state.data.borrow_mut()[..])?;

    msg!("Escrow created: recipient={}", recipient);
    Ok(())
}

// ---------------------------------------------------------------------------
// Deposit  →  Active  (recipient may claim immediately after this)
// ---------------------------------------------------------------------------

fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String, amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let depositor = next_account_info(it)?;
    let state     = next_account_info(it)?;
    let vault     = next_account_info(it)?;
    let sysprog   = next_account_info(it)?;

    if !depositor.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if amount == 0 { return Err(EscrowError::ZeroDeposit.into()); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;
    verify_pda(program_id, b"vault",  &id, vault.key)?;

    let mut s = load(state)?;
    if s.status != EscrowStatus::Pending { return Err(EscrowError::AlreadyFunded.into()); }

    invoke(
        &system_instruction::transfer(depositor.key, vault.key, amount),
        &[depositor.clone(), vault.clone(), sysprog.clone()],
    )?;

    s.depositor = *depositor.key;
    s.amount    = amount;
    s.status    = EscrowStatus::Active;
    save(state, &s)?;

    msg!("Deposit: {} lamports locked in vault. Recipient may claim now.", amount);
    Ok(())
}

// ---------------------------------------------------------------------------
// ClaimFunds  →  Released  (no timer — available immediately after deposit)
// ---------------------------------------------------------------------------

fn claim_funds(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String) -> ProgramResult {
    let it = &mut accounts.iter();
    let recipient = next_account_info(it)?;
    let state     = next_account_info(it)?;
    let vault     = next_account_info(it)?;
    let _sys      = next_account_info(it)?;

    if !recipient.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;
    verify_pda(program_id, b"vault",  &id, vault.key)?;

    let mut s = load(state)?;
    if s.status != EscrowStatus::Active     { return Err(EscrowError::InvalidStatus.into()); }
    if s.recipient != *recipient.key        { return Err(EscrowError::WrongRecipient.into()); }

    drain_vault(vault, recipient)?;
    s.status = EscrowStatus::Released;
    save(state, &s)?;

    msg!("Funds released to recipient {}", recipient.key);
    Ok(())
}

// ---------------------------------------------------------------------------
// RaiseDispute  →  Disputed  (depositor can freeze funds any time while Active)
// ---------------------------------------------------------------------------

fn raise_dispute(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String) -> ProgramResult {
    let it = &mut accounts.iter();
    let depositor = next_account_info(it)?;
    let state     = next_account_info(it)?;

    if !depositor.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;

    let mut s = load(state)?;
    if s.status != EscrowStatus::Active  { return Err(EscrowError::InvalidStatus.into()); }
    if s.depositor != *depositor.key     { return Err(EscrowError::Unauthorized.into()); }

    s.status = EscrowStatus::Disputed;
    save(state, &s)?;

    msg!("Dispute raised by {} — admin arbitration required", depositor.key);
    Ok(())
}

// ---------------------------------------------------------------------------
// ResolveDispute  →  Released | Refunded  (admin only)
// ---------------------------------------------------------------------------

fn resolve_dispute(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String, release_to_recipient: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin  = next_account_info(it)?;
    let state  = next_account_info(it)?;
    let vault  = next_account_info(it)?;
    let payout = next_account_info(it)?;
    let _sys   = next_account_info(it)?;

    if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;
    verify_pda(program_id, b"vault",  &id, vault.key)?;

    let mut s = load(state)?;
    if s.status != EscrowStatus::Disputed { return Err(EscrowError::InvalidStatus.into()); }
    if s.admin != *admin.key              { return Err(EscrowError::Unauthorized.into()); }

    if release_to_recipient {
        if s.recipient != *payout.key { return Err(EscrowError::WrongRecipient.into()); }
        drain_vault(vault, payout)?;
        s.status = EscrowStatus::Released;
        msg!("Dispute resolved: released to recipient");
    } else {
        if s.depositor != *payout.key { return Err(EscrowError::Unauthorized.into()); }
        drain_vault(vault, payout)?;
        s.status = EscrowStatus::Refunded;
        msg!("Dispute resolved: refunded to depositor");
    }
    save(state, &s)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// EmergencyRefund  →  Refunded  (admin safety valve)
// ---------------------------------------------------------------------------

fn emergency_refund(program_id: &Pubkey, accounts: &[AccountInfo], escrow_id: String) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin     = next_account_info(it)?;
    let state     = next_account_info(it)?;
    let vault     = next_account_info(it)?;
    let depositor = next_account_info(it)?;
    let _sys      = next_account_info(it)?;

    if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let id = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id, state.key)?;
    verify_pda(program_id, b"vault",  &id, vault.key)?;

    let mut s = load(state)?;
    if s.admin != *admin.key { return Err(EscrowError::Unauthorized.into()); }
    if matches!(s.status, EscrowStatus::Released | EscrowStatus::Refunded) {
        return Err(EscrowError::InvalidStatus.into());
    }
    if s.depositor != *depositor.key { return Err(EscrowError::Unauthorized.into()); }

    drain_vault(vault, depositor)?;
    s.status = EscrowStatus::Refunded;
    save(state, &s)?;

    msg!("Emergency refund to {}", depositor.key);
    Ok(())
}
