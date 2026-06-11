pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

/// The one and only recipient — hardcoded on-chain. Funds can never be
/// routed anywhere else regardless of what the client sends.
pub const RECEIVER: &str = "5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f";

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, instruction_data)
}

solana_program::declare_id!("Escrow11111111111111111111111111111111111111");
