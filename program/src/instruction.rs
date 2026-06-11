use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum EscrowInstruction {
    /// Admin creates an escrow slot.
    /// Accounts: admin(sw), escrow_state_pda(w), vault_pda(w), system_program
    CreateEscrow {
        escrow_id: String,
        recipient: Pubkey,
    },

    /// Depositor locks funds. Recipient can claim immediately after this.
    /// Accounts: depositor(sw), escrow_state_pda(w), vault_pda(w), system_program
    Deposit {
        escrow_id: String,
        amount: u64,
    },

    /// Recipient claims funds immediately — no timer, no admin approval.
    /// Accounts: recipient(sw), escrow_state_pda(w), vault_pda(w), system_program
    ClaimFunds {
        escrow_id: String,
    },

    /// Depositor raises a dispute — freezes funds for admin review.
    /// Can be raised any time while status is Active.
    /// Accounts: depositor(s), escrow_state_pda(w)
    RaiseDispute {
        escrow_id: String,
    },

    /// Admin resolves a dispute — releases to recipient or refunds depositor.
    /// Accounts: admin(s), escrow_state_pda(w), vault_pda(w), payout(w), system_program
    ResolveDispute {
        escrow_id: String,
        release_to_recipient: bool,
    },

    /// Admin emergency refund — returns funds to depositor at any point.
    /// Accounts: admin(s), escrow_state_pda(w), vault_pda(w), depositor(w), system_program
    EmergencyRefund {
        escrow_id: String,
    },
}
