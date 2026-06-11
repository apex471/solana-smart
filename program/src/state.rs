use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const ESCROW_ID_LEN: usize = 32;
pub const ESCROW_STATE_DISCRIMINATOR: u8 = 1;

/// discriminator(1) + admin(32) + depositor(32) + recipient(32) + amount(8)
/// + status(1) + escrow_id(32) + created_at(8) + bump(1) = 147
pub const ESCROW_STATE_SIZE: usize = 147;

#[repr(u8)]
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq)]
pub enum EscrowStatus {
    /// Admin created the slot — waiting for depositor.
    Pending   = 0,
    /// Funds sent directly to recipient — escrow complete.
    Released  = 1,
    /// Admin cancelled before deposit.
    Cancelled = 2,
    /// Admin emergency refund after deposit (edge case).
    Refunded  = 3,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct EscrowState {
    pub discriminator: u8,
    /// Admin who created and controls this escrow.
    pub admin:         Pubkey,
    /// Set on deposit — who paid.
    pub depositor:     Pubkey,
    /// Pre-set by admin — receives funds the moment depositor signs.
    pub recipient:     Pubkey,
    /// Lamports paid.
    pub amount:        u64,
    pub status:        EscrowStatus,
    pub escrow_id:     [u8; ESCROW_ID_LEN],
    pub created_at:    i64,
    pub bump:          u8,
}

impl EscrowState {
    pub fn is_initialized(&self) -> bool {
        self.discriminator == ESCROW_STATE_DISCRIMINATOR
    }
}
