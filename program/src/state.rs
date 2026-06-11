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
    Pending  = 0,
    Active   = 1,
    Disputed = 2,
    Released = 3,
    Refunded = 4,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct EscrowState {
    pub discriminator: u8,
    pub admin:         Pubkey,
    pub depositor:     Pubkey,
    pub recipient:     Pubkey,
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
