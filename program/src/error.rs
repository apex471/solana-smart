use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq)]
pub enum EscrowError {
    #[error("Account not initialized")]
    UninitializedAccount,

    #[error("Invalid instruction")]
    InvalidInstruction,

    #[error("Not authorized — only admin can perform this action")]
    Unauthorized,

    #[error("Escrow is not in the expected status for this operation")]
    InvalidStatus,

    #[error("Deposit amount must be greater than zero")]
    ZeroDeposit,

    #[error("Arithmetic overflow")]
    Overflow,

    #[error("Invalid account owner")]
    InvalidOwner,

    #[error("Incorrect program-derived address")]
    InvalidPDA,

    #[error("Escrow has already been funded")]
    AlreadyFunded,

    #[error("Escrow ID too long (max 32 bytes)")]
    EscrowIdTooLong,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
