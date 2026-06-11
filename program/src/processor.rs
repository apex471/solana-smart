use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
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
// PDA seed helpers
// ---------------------------------------------------------------------------

fn escrow_seeds(escrow_id_bytes: &[u8; ESCROW_ID_LEN]) -> [&[u8]; 2] {
    [b"escrow", escrow_id_bytes.as_ref()]
}

fn vault_seeds(escrow_id_bytes: &[u8; ESCROW_ID_LEN]) -> [&[u8]; 2] {
    [b"vault", escrow_id_bytes.as_ref()]
}

fn id_to_bytes(escrow_id: &str) -> Result<[u8; ESCROW_ID_LEN], ProgramError> {
    let bytes = escrow_id.as_bytes();
    if bytes.len() > ESCROW_ID_LEN {
        return Err(EscrowError::EscrowIdTooLong.into());
    }
    let mut buf = [0u8; ESCROW_ID_LEN];
    buf[..bytes.len()].copy_from_slice(bytes);
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = EscrowInstruction::try_from_slice(instruction_data)
        .map_err(|_| EscrowError::InvalidInstruction)?;

    match instruction {
        EscrowInstruction::CreateEscrow { escrow_id, recipient } => {
            msg!("Instruction: CreateEscrow [{}]", escrow_id);
            process_create_escrow(program_id, accounts, escrow_id, recipient)
        }
        EscrowInstruction::Deposit { escrow_id, amount } => {
            msg!("Instruction: Deposit [{}] {} lamports", escrow_id, amount);
            process_deposit(program_id, accounts, escrow_id, amount)
        }
        EscrowInstruction::ReleaseFunds { escrow_id } => {
            msg!("Instruction: ReleaseFunds [{}]", escrow_id);
            process_release_funds(program_id, accounts, escrow_id)
        }
        EscrowInstruction::Refund { escrow_id } => {
            msg!("Instruction: Refund [{}]", escrow_id);
            process_refund(program_id, accounts, escrow_id)
        }
    }
}

// ---------------------------------------------------------------------------
// CreateEscrow
// ---------------------------------------------------------------------------

fn process_create_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
    recipient: Pubkey,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let admin_info = next_account_info(account_iter)?;
    let escrow_state_info = next_account_info(account_iter)?;
    let vault_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;

    // Derive & verify escrow_state PDA
    let (escrow_pda, escrow_bump) =
        Pubkey::find_program_address(&[b"escrow", &id_bytes], program_id);
    if escrow_pda != *escrow_state_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }

    // Derive & verify vault PDA
    let (vault_pda, _vault_bump) =
        Pubkey::find_program_address(&[b"vault", &id_bytes], program_id);
    if vault_pda != *vault_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }

    // Allocate escrow_state account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(ESCROW_STATE_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            admin_info.key,
            &escrow_pda,
            lamports,
            ESCROW_STATE_SIZE as u64,
            program_id,
        ),
        &[admin_info.clone(), escrow_state_info.clone(), system_program_info.clone()],
        &[&[b"escrow", &id_bytes, &[escrow_bump]]],
    )?;

    // Write initial state
    let clock = Clock::get()?;
    let state = EscrowState {
        discriminator: ESCROW_STATE_DISCRIMINATOR,
        admin: *admin_info.key,
        depositor: Pubkey::default(), // set on first Deposit
        recipient,
        amount: 0,
        status: EscrowStatus::Pending,
        escrow_id: id_bytes,
        created_at: clock.unix_timestamp,
        bump: escrow_bump,
    };
    state.serialize(&mut &mut escrow_state_info.data.borrow_mut()[..])?;

    msg!(
        "Escrow created: id={} admin={} recipient={}",
        escrow_id,
        admin_info.key,
        recipient
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Deposit  (Pending → Active)
// ---------------------------------------------------------------------------

fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
    amount: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let depositor_info = next_account_info(account_iter)?;
    let escrow_state_info = next_account_info(account_iter)?;
    let vault_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !depositor_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if amount == 0 {
        return Err(EscrowError::ZeroDeposit.into());
    }

    let id_bytes = id_to_bytes(&escrow_id)?;

    // Verify PDAs
    let (escrow_pda, _) = Pubkey::find_program_address(&[b"escrow", &id_bytes], program_id);
    if escrow_pda != *escrow_state_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }
    let (vault_pda, _) = Pubkey::find_program_address(&[b"vault", &id_bytes], program_id);
    if vault_pda != *vault_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }

    // Load & validate state
    let mut state = EscrowState::try_from_slice(&escrow_state_info.data.borrow())
        .map_err(|_| EscrowError::UninitializedAccount)?;
    if !state.is_initialized() {
        return Err(EscrowError::UninitializedAccount.into());
    }
    if state.status != EscrowStatus::Pending {
        return Err(EscrowError::AlreadyFunded.into());
    }

    // Transfer SOL depositor → vault
    invoke(
        &system_instruction::transfer(depositor_info.key, &vault_pda, amount),
        &[depositor_info.clone(), vault_info.clone(), system_program_info.clone()],
    )?;

    // Update state
    state.depositor = *depositor_info.key;
    state.amount = amount;
    state.status = EscrowStatus::Active;
    state.serialize(&mut &mut escrow_state_info.data.borrow_mut()[..])?;

    msg!(
        "Deposit successful: {} lamports locked for escrow {}",
        amount,
        escrow_id
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// ReleaseFunds  (Active → Released)
// ---------------------------------------------------------------------------

fn process_release_funds(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let admin_info = next_account_info(account_iter)?;
    let escrow_state_info = next_account_info(account_iter)?;
    let vault_info = next_account_info(account_iter)?;
    let recipient_info = next_account_info(account_iter)?;
    let _system_program_info = next_account_info(account_iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;

    // Verify PDAs
    let (escrow_pda, _) = Pubkey::find_program_address(&[b"escrow", &id_bytes], program_id);
    if escrow_pda != *escrow_state_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }
    let (vault_pda, vault_bump) = Pubkey::find_program_address(&[b"vault", &id_bytes], program_id);
    if vault_pda != *vault_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }

    // Load & validate state
    let mut state = EscrowState::try_from_slice(&escrow_state_info.data.borrow())
        .map_err(|_| EscrowError::UninitializedAccount)?;
    if !state.is_initialized() {
        return Err(EscrowError::UninitializedAccount.into());
    }
    if state.admin != *admin_info.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if state.status != EscrowStatus::Active {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.recipient != *recipient_info.key {
        return Err(EscrowError::Unauthorized.into());
    }

    let vault_balance = vault_info.lamports();

    // Transfer vault → recipient using PDA signature
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(vault_balance)
        .ok_or(EscrowError::Overflow)?;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(vault_balance)
        .ok_or(EscrowError::Overflow)?;

    // Update state
    state.status = EscrowStatus::Released;
    state.serialize(&mut &mut escrow_state_info.data.borrow_mut()[..])?;

    msg!(
        "Funds released: {} lamports → {} for escrow {}",
        vault_balance,
        recipient_info.key,
        escrow_id
    );
    let _ = vault_bump; // consumed in find_program_address
    Ok(())
}

// ---------------------------------------------------------------------------
// Refund  (Active → Refunded)
// ---------------------------------------------------------------------------

fn process_refund(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let admin_info = next_account_info(account_iter)?;
    let escrow_state_info = next_account_info(account_iter)?;
    let vault_info = next_account_info(account_iter)?;
    let depositor_info = next_account_info(account_iter)?;
    let _system_program_info = next_account_info(account_iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;

    // Verify PDAs
    let (escrow_pda, _) = Pubkey::find_program_address(&[b"escrow", &id_bytes], program_id);
    if escrow_pda != *escrow_state_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }
    let (vault_pda, _) = Pubkey::find_program_address(&[b"vault", &id_bytes], program_id);
    if vault_pda != *vault_info.key {
        return Err(EscrowError::InvalidPDA.into());
    }

    // Load & validate state
    let mut state = EscrowState::try_from_slice(&escrow_state_info.data.borrow())
        .map_err(|_| EscrowError::UninitializedAccount)?;
    if !state.is_initialized() {
        return Err(EscrowError::UninitializedAccount.into());
    }
    if state.admin != *admin_info.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if state.status != EscrowStatus::Active {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.depositor != *depositor_info.key {
        return Err(EscrowError::Unauthorized.into());
    }

    let vault_balance = vault_info.lamports();

    // Transfer vault → depositor
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(vault_balance)
        .ok_or(EscrowError::Overflow)?;
    **depositor_info.try_borrow_mut_lamports()? = depositor_info
        .lamports()
        .checked_add(vault_balance)
        .ok_or(EscrowError::Overflow)?;

    // Update state
    state.status = EscrowStatus::Refunded;
    state.serialize(&mut &mut escrow_state_info.data.borrow_mut()[..])?;

    msg!(
        "Refund processed: {} lamports → {} for escrow {}",
        vault_balance,
        depositor_info.key,
        escrow_id
    );
    Ok(())
}
