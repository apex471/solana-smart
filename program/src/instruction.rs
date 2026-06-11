use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum EscrowInstruction {
    /// Admin creates an escrow slot with a pre-set recipient.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` admin
    ///   1. `[writable]`         escrow_state PDA  ["escrow", escrow_id]
    ///   2. `[]`                 system_program
    CreateEscrow {
        escrow_id: String,
        /// Address that receives funds the moment depositor signs.
        recipient: Pubkey,
    },

    /// Depositor approves and pays — funds go directly to recipient in this
    /// same instruction. No vault, no waiting, no second step.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` depositor
    ///   1. `[writable]`         escrow_state PDA
    ///   2. `[writable]`         recipient
    ///   3. `[]`                 system_program
    Deposit {
        escrow_id: String,
        amount:    u64,
    },

    /// Admin cancels a Pending escrow (before anyone has deposited).
    ///
    /// Accounts:
    ///   0. `[signer]`    admin
    ///   1. `[writable]`  escrow_state PDA
    CancelEscrow {
        escrow_id: String,
    },
}
