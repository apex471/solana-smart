use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum EscrowInstruction {
    /// Admin creates an escrow slot with timing parameters.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` admin
    ///   1. `[writable]`         escrow_state PDA  ["escrow", escrow_id]
    ///   2. `[writable]`         vault PDA         ["vault",  escrow_id]
    ///   3. `[]`                 system_program
    CreateEscrow {
        escrow_id: String,
        recipient: Pubkey,
        /// Seconds after deposit before recipient can auto-claim.
        lockup_seconds: i64,
        /// Seconds after deposit during which depositor may dispute.
        /// Must be <= lockup_seconds.
        dispute_window_seconds: i64,
    },

    /// Depositor locks funds — starts the auto-release countdown.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` depositor
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[]`                 system_program
    Deposit {
        escrow_id: String,
        amount: u64,
    },

    /// Recipient claims funds after lockup expires — no admin needed.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` recipient
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[]`                 system_program
    ClaimFunds {
        escrow_id: String,
    },

    /// Depositor raises a dispute within the dispute window — freezes funds.
    ///
    /// Accounts:
    ///   0. `[signer]`           depositor
    ///   1. `[writable]`         escrow_state PDA
    RaiseDispute {
        escrow_id: String,
    },

    /// Admin resolves a disputed escrow — releases or refunds.
    ///
    /// Accounts:
    ///   0. `[signer]`           admin
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[writable]`         recipient OR depositor (whoever receives)
    ///   4. `[]`                 system_program
    ResolveDispute {
        escrow_id: String,
        /// true  = release to recipient, false = refund to depositor
        release_to_recipient: bool,
    },

    /// Admin emergency refund — available at any status as a safety valve.
    ///
    /// Accounts:
    ///   0. `[signer]`           admin
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[writable]`         depositor
    ///   4. `[]`                 system_program
    EmergencyRefund {
        escrow_id: String,
    },
}
