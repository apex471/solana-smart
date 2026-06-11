use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const ESCROW_ID_LEN: usize = 32;
pub const ESCROW_STATE_DISCRIMINATOR: u8 = 1;

/// discriminator(1) + admin(32) + depositor(32) + recipient(32) + amount(8)
/// + status(1) + escrow_id(32) + created_at(8) + release_after(8)
/// + dispute_window(8) + bump(1) = 163
pub const ESCROW_STATE_SIZE: usize = 163;

#[repr(u8)]
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq)]
pub enum EscrowStatus {
    /// Admin created slot, no funds yet.
    Pending = 0,
    /// Funded — countdown to auto-release is running.
    Active = 1,
    /// Depositor raised a dispute — funds frozen, admin must resolve.
    Disputed = 2,
    /// Recipient claimed funds (auto-released).
    Released = 3,
    /// Funds returned to depositor (admin-resolved dispute or emergency).
    Refunded = 4,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct EscrowState {
    pub discriminator: u8,
    /// Admin arbitrator — only needed for disputed escrows.
    pub admin: Pubkey,
    /// Who deposited funds.
    pub depositor: Pubkey,
    /// Who receives funds on successful claim.
    pub recipient: Pubkey,
    /// Lamports locked in the vault PDA.
    pub amount: u64,
    pub status: EscrowStatus,
    pub escrow_id: [u8; ESCROW_ID_LEN],
    /// Unix timestamp of deposit.
    pub created_at: i64,
    /// Unix timestamp after which recipient can claim without approval.
    pub release_after: i64,
    /// Seconds after deposit during which depositor may raise a dispute.
    pub dispute_window: i64,
    pub bump: u8,
}

impl EscrowState {
    pub fn is_initialized(&self) -> bool {
        self.discriminator == ESCROW_STATE_DISCRIMINATOR
    }
}
