use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq)]
pub enum EscrowError {
    #[error("Account not initialized")]
    UninitializedAccount,
    #[error("Invalid instruction")]
    InvalidInstruction,
    #[error("Not authorized")]
    Unauthorized,
    #[error("Escrow is not in Pending status")]
    NotPending,
    #[error("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[error("Arithmetic overflow")]
    Overflow,
    #[error("Incorrect program-derived address")]
    InvalidPDA,
    #[error("Escrow ID too long (max 32 bytes)")]
    EscrowIdTooLong,
    #[error("Recipient account does not match escrow")]
    WrongRecipient,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
