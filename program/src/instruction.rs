use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// All instructions understood by the Escrow program.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum EscrowInstruction {
    /// Admin creates an escrow slot.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` admin
    ///   1. `[writable]`         escrow_state PDA  (seeds: ["escrow", escrow_id])
    ///   2. `[writable]`         vault PDA         (seeds: ["vault",  escrow_id])
    ///   3. `[]`                 system_program
    CreateEscrow {
        /// Unique identifier string (max 32 bytes UTF-8).
        escrow_id: String,
        /// Who will receive the funds when released.
        recipient: Pubkey,
    },

    /// Depositor funds the escrow — moves status Pending → Active.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` depositor
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[]`                 system_program
    Deposit {
        escrow_id: String,
        /// Lamports to lock in the vault.
        amount: u64,
    },

    /// Admin releases vault funds to recipient — status Active → Released.
    ///
    /// Accounts:
    ///   0. `[signer]`           admin
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[writable]`         recipient
    ///   4. `[]`                 system_program
    ReleaseFunds {
        escrow_id: String,
    },

    /// Admin refunds vault funds to depositor — status Active → Refunded.
    ///
    /// Accounts:
    ///   0. `[signer]`           admin
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         vault PDA
    ///   3. `[writable]`         depositor
    ///   4. `[]`                 system_program
    Refund {
        escrow_id: String,
    },
}
