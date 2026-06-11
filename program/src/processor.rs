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
    state::{
        EscrowState, EscrowStatus, ESCROW_ID_LEN, ESCROW_STATE_DISCRIMINATOR, ESCROW_STATE_SIZE,
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn id_to_bytes(escrow_id: &str) -> Result<[u8; ESCROW_ID_LEN], ProgramError> {
    let bytes = escrow_id.as_bytes();
    if bytes.len() > ESCROW_ID_LEN {
        return Err(EscrowError::EscrowIdTooLong.into());
    }
    let mut buf = [0u8; ESCROW_ID_LEN];
    buf[..bytes.len()].copy_from_slice(bytes);
    Ok(buf)
}

/// Move all lamports from vault to destination by directly adjusting balances.
/// This works because vault is a PDA owned by this program with no data.
fn drain_vault(vault: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    let amount = vault.lamports();
    if amount == 0 {
        return Ok(());
    }
    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(amount)
        .ok_or(EscrowError::Overflow)?;
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(amount)
        .ok_or(EscrowError::Overflow)?;
    Ok(())
}

fn verify_pda(
    program_id: &Pubkey,
    prefix: &[u8],
    id_bytes: &[u8; ESCROW_ID_LEN],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    let (pda, bump) = Pubkey::find_program_address(&[prefix, id_bytes], program_id);
    if pda != *expected {
        return Err(EscrowError::InvalidPDA.into());
    }
    Ok(bump)
}

fn load_state(info: &AccountInfo) -> Result<EscrowState, ProgramError> {
    let state = EscrowState::try_from_slice(&info.data.borrow())
        .map_err(|_| EscrowError::UninitializedAccount)?;
    if !state.is_initialized() {
        return Err(EscrowError::UninitializedAccount.into());
    }
    Ok(state)
}

fn save_state(info: &AccountInfo, state: &EscrowState) -> ProgramResult {
    state
        .serialize(&mut &mut info.data.borrow_mut()[..])
        .map_err(|_| ProgramError::InvalidAccountData)
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
        EscrowInstruction::CreateEscrow {
            escrow_id,
            recipient,
            lockup_seconds,
            dispute_window_seconds,
        } => {
            msg!("CreateEscrow [{}]", escrow_id);
            process_create_escrow(
                program_id,
                accounts,
                escrow_id,
                recipient,
                lockup_seconds,
                dispute_window_seconds,
            )
        }
        EscrowInstruction::Deposit { escrow_id, amount } => {
            msg!("Deposit [{}] {}", escrow_id, amount);
            process_deposit(program_id, accounts, escrow_id, amount)
        }
        EscrowInstruction::ClaimFunds { escrow_id } => {
            msg!("ClaimFunds [{}]", escrow_id);
            process_claim_funds(program_id, accounts, escrow_id)
        }
        EscrowInstruction::RaiseDispute { escrow_id } => {
            msg!("RaiseDispute [{}]", escrow_id);
            process_raise_dispute(program_id, accounts, escrow_id)
        }
        EscrowInstruction::ResolveDispute { escrow_id, release_to_recipient } => {
            msg!("ResolveDispute [{}] release={}", escrow_id, release_to_recipient);
            process_resolve_dispute(program_id, accounts, escrow_id, release_to_recipient)
        }
        EscrowInstruction::EmergencyRefund { escrow_id } => {
            msg!("EmergencyRefund [{}]", escrow_id);
            process_emergency_refund(program_id, accounts, escrow_id)
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
    lockup_seconds: i64,
    dispute_window_seconds: i64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let admin_info       = next_account_info(iter)?;
    let state_info       = next_account_info(iter)?;
    let vault_info       = next_account_info(iter)?;
    let system_prog_info = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if lockup_seconds <= 0
        || dispute_window_seconds < 0
        || dispute_window_seconds > lockup_seconds
    {
        return Err(EscrowError::InvalidTiming.into());
    }

    let id_bytes   = id_to_bytes(&escrow_id)?;
    let state_bump = verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;
    verify_pda(program_id, b"vault", &id_bytes, vault_info.key)?;

    // Allocate state account
    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(ESCROW_STATE_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            admin_info.key,
            state_info.key,
            lamports,
            ESCROW_STATE_SIZE as u64,
            program_id,
        ),
        &[admin_info.clone(), state_info.clone(), system_prog_info.clone()],
        &[&[b"escrow", &id_bytes, &[state_bump]]],
    )?;

    let clock = Clock::get()?;
    EscrowState {
        discriminator:  ESCROW_STATE_DISCRIMINATOR,
        admin:          *admin_info.key,
        depositor:      Pubkey::default(),
        recipient,
        amount:         0,
        status:         EscrowStatus::Pending,
        escrow_id:      id_bytes,
        created_at:     clock.unix_timestamp,
        // Store lockup_seconds in release_after while Pending.
        // On Deposit this gets replaced with: now + lockup_seconds.
        release_after:  lockup_seconds,
        dispute_window: dispute_window_seconds,
        bump:           state_bump,
    }
    .serialize(&mut &mut state_info.data.borrow_mut()[..])?;

    msg!(
        "Escrow created: lockup={}s dispute_window={}s recipient={}",
        lockup_seconds,
        dispute_window_seconds,
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
    let iter = &mut accounts.iter();
    let depositor_info   = next_account_info(iter)?;
    let state_info       = next_account_info(iter)?;
    let vault_info       = next_account_info(iter)?;
    let system_prog_info = next_account_info(iter)?;

    if !depositor_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if amount == 0 {
        return Err(EscrowError::ZeroDeposit.into());
    }

    let id_bytes = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;
    verify_pda(program_id, b"vault",  &id_bytes, vault_info.key)?;

    let mut state = load_state(state_info)?;
    if state.status != EscrowStatus::Pending {
        return Err(EscrowError::AlreadyFunded.into());
    }

    // Transfer lamports to vault PDA
    invoke(
        &system_instruction::transfer(depositor_info.key, vault_info.key, amount),
        &[depositor_info.clone(), vault_info.clone(), system_prog_info.clone()],
    )?;

    let clock         = Clock::get()?;
    let lockup_secs   = state.release_after; // stashed during CreateEscrow
    state.depositor   = *depositor_info.key;
    state.amount      = amount;
    state.status      = EscrowStatus::Active;
    state.created_at  = clock.unix_timestamp;
    state.release_after = clock
        .unix_timestamp
        .checked_add(lockup_secs)
        .ok_or(EscrowError::Overflow)?;

    save_state(state_info, &state)?;

    msg!(
        "Deposit confirmed: {} lamports locked. Auto-release eligible at unix timestamp {}",
        amount,
        state.release_after
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// ClaimFunds  (Active → Released)  — trustless, no admin
// ---------------------------------------------------------------------------

fn process_claim_funds(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let recipient_info   = next_account_info(iter)?;
    let state_info       = next_account_info(iter)?;
    let vault_info       = next_account_info(iter)?;
    let _system_prog     = next_account_info(iter)?;

    if !recipient_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;
    verify_pda(program_id, b"vault",  &id_bytes, vault_info.key)?;

    let mut state = load_state(state_info)?;

    if state.status != EscrowStatus::Active {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.recipient != *recipient_info.key {
        return Err(EscrowError::WrongRecipient.into());
    }

    let clock = Clock::get()?;
    if clock.unix_timestamp < state.release_after {
        return Err(EscrowError::LockupNotExpired.into());
    }

    drain_vault(vault_info, recipient_info)?;
    state.status = EscrowStatus::Released;
    save_state(state_info, &state)?;

    msg!("ClaimFunds: {} → recipient {}", escrow_id, recipient_info.key);
    Ok(())
}

// ---------------------------------------------------------------------------
// RaiseDispute  (Active → Disputed)
// ---------------------------------------------------------------------------

fn process_raise_dispute(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let depositor_info = next_account_info(iter)?;
    let state_info     = next_account_info(iter)?;

    if !depositor_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;

    let mut state = load_state(state_info)?;

    if state.status != EscrowStatus::Active {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.depositor != *depositor_info.key {
        return Err(EscrowError::Unauthorized.into());
    }

    let clock            = Clock::get()?;
    let dispute_deadline = state
        .created_at
        .checked_add(state.dispute_window)
        .ok_or(EscrowError::Overflow)?;

    if clock.unix_timestamp > dispute_deadline {
        return Err(EscrowError::DisputeWindowClosed.into());
    }

    state.status = EscrowStatus::Disputed;
    save_state(state_info, &state)?;

    msg!(
        "Dispute raised by {} — admin arbitration required for escrow {}",
        depositor_info.key,
        escrow_id
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// ResolveDispute  (Disputed → Released | Refunded)  — admin only
// ---------------------------------------------------------------------------

fn process_resolve_dispute(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
    release_to_recipient: bool,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let admin_info       = next_account_info(iter)?;
    let state_info       = next_account_info(iter)?;
    let vault_info       = next_account_info(iter)?;
    let payout_info      = next_account_info(iter)?;
    let _system_prog     = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;
    verify_pda(program_id, b"vault",  &id_bytes, vault_info.key)?;

    let mut state = load_state(state_info)?;

    if state.status != EscrowStatus::Disputed {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.admin != *admin_info.key {
        return Err(EscrowError::Unauthorized.into());
    }

    if release_to_recipient {
        if state.recipient != *payout_info.key {
            return Err(EscrowError::WrongRecipient.into());
        }
        drain_vault(vault_info, payout_info)?;
        state.status = EscrowStatus::Released;
        msg!("Dispute → released to recipient {}", payout_info.key);
    } else {
        if state.depositor != *payout_info.key {
            return Err(EscrowError::Unauthorized.into());
        }
        drain_vault(vault_info, payout_info)?;
        state.status = EscrowStatus::Refunded;
        msg!("Dispute → refunded to depositor {}", payout_info.key);
    }

    save_state(state_info, &state)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// EmergencyRefund  (Active | Disputed → Refunded)  — admin safety valve
// ---------------------------------------------------------------------------

fn process_emergency_refund(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: String,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let admin_info       = next_account_info(iter)?;
    let state_info       = next_account_info(iter)?;
    let vault_info       = next_account_info(iter)?;
    let depositor_info   = next_account_info(iter)?;
    let _system_prog     = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let id_bytes = id_to_bytes(&escrow_id)?;
    verify_pda(program_id, b"escrow", &id_bytes, state_info.key)?;
    verify_pda(program_id, b"vault",  &id_bytes, vault_info.key)?;

    let mut state = load_state(state_info)?;

    if state.admin != *admin_info.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if matches!(state.status, EscrowStatus::Released | EscrowStatus::Refunded) {
        return Err(EscrowError::InvalidStatus.into());
    }
    if state.depositor != *depositor_info.key {
        return Err(EscrowError::Unauthorized.into());
    }

    drain_vault(vault_info, depositor_info)?;
    state.status = EscrowStatus::Refunded;
    save_state(state_info, &state)?;

    msg!("EmergencyRefund → {}", depositor_info.key);
    Ok(())
}
