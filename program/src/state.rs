use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Maximum length of a string escrow ID stored on-chain.
pub const ESCROW_ID_LEN: usize = 32;

/// Discriminator written as the first byte so we can identify account types.
pub const ESCROW_STATE_DISCRIMINATOR: u8 = 1;

/// Size of the serialized EscrowState on-chain.
/// discriminator(1) + admin(32) + depositor(32) + recipient(32) + amount(8)
/// + status(1) + escrow_id([u8;32]=32) + created_at(8) + bump(1) = 147
pub const ESCROW_STATE_SIZE: usize = 147;

#[repr(u8)]
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq)]
pub enum EscrowStatus {
    /// Created by admin, waiting for depositor funds.
    Pending = 0,
    /// Funds deposited — work is in progress.
    Active = 1,
    /// Admin released funds to recipient — contract complete.
    Released = 2,
    /// Admin refunded depositor — contract cancelled.
    Refunded = 3,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct EscrowState {
    /// Account type discriminator.
    pub discriminator: u8,
    /// Admin who controls this escrow (creates, releases, refunds).
    pub admin: Pubkey,
    /// Party that deposited funds.
    pub depositor: Pubkey,
    /// Party that receives funds on successful release.
    pub recipient: Pubkey,
    /// Lamports locked in the vault PDA.
    pub amount: u64,
    /// Current lifecycle status.
    pub status: EscrowStatus,
    /// Unique identifier for this escrow (max 32 bytes, zero-padded).
    pub escrow_id: [u8; ESCROW_ID_LEN],
    /// Unix timestamp when the escrow was created.
    pub created_at: i64,
    /// PDA bump seed for the EscrowState account.
    pub bump: u8,
}

impl EscrowState {
    pub fn is_initialized(&self) -> bool {
        self.discriminator == ESCROW_STATE_DISCRIMINATOR
    }
}
