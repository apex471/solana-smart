import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  EscrowStateData,
  EscrowStatus,
  ESCROW_STATUS_LABELS,
  deserializeEscrowState,
  encodeClaimFunds,
  encodeCreateEscrow,
  encodeDeposit,
  encodeEmergencyRefund,
  encodeRaiseDispute,
  encodeResolveDispute,
} from "./schema";

export { EscrowStatus, ESCROW_STATUS_LABELS };
export type { EscrowStateData };

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

function padId(escrowId: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(escrowId.slice(0, 32)).copy(b);
  return b;
}

export function deriveEscrowStatePDA(
  programId: PublicKey,
  escrowId: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), padId(escrowId)],
    programId
  );
}

export function deriveVaultPDA(
  programId: PublicKey,
  escrowId: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), padId(escrowId)],
    programId
  );
}

// ---------------------------------------------------------------------------
// EscrowClient
// ---------------------------------------------------------------------------

export class EscrowClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey
  ) {}

  /**
   * Admin creates an escrow.
   * @param lockupSeconds     How many seconds after deposit before recipient can claim.
   * @param disputeWindowSecs How many seconds after deposit the depositor may raise a dispute.
   */
  async createEscrow(
    admin: Keypair,
    escrowId: string,
    recipient: PublicKey,
    lockupSeconds: number,
    disputeWindowSeconds: number
  ): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    const data = encodeCreateEscrow(
      escrowId,
      recipient.toBytes(),
      BigInt(lockupSeconds),
      BigInt(disputeWindowSeconds)
    );
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,        isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [admin]
    );
  }

  /** Depositor funds the escrow — starts the auto-release countdown. */
  async deposit(
    depositor: Keypair,
    escrowId: string,
    amountSol: number
  ): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const data = encodeDeposit(escrowId, lamports);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [depositor]
    );
  }

  /**
   * Recipient claims funds after lockup expires — no admin required.
   * Call fetchEscrowState first to check if release_after has passed.
   */
  async claimFunds(recipient: Keypair, escrowId: string): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    const data = encodeClaimFunds(escrowId);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: recipient.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [recipient]
    );
  }

  /** Depositor raises a dispute — must be within the dispute window. */
  async raiseDispute(depositor: Keypair, escrowId: string): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const data = encodeRaiseDispute(escrowId);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true,  isWritable: false },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [depositor]
    );
  }

  /** Admin resolves a disputed escrow. */
  async resolveDispute(
    admin: Keypair,
    escrowId: string,
    releaseToRecipient: boolean,
    payoutPubkey: PublicKey
  ): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    const data = encodeResolveDispute(escrowId, releaseToRecipient);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey,  isSigner: true,  isWritable: false },
        { pubkey: statePDA,         isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,         isSigner: false, isWritable: true  },
        { pubkey: payoutPubkey,     isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [admin]
    );
  }

  /** Admin emergency refund — bypasses lockup, returns funds to depositor. */
  async emergencyRefund(
    admin: Keypair,
    escrowId: string,
    depositor: PublicKey
  ): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    const data = encodeEmergencyRefund(escrowId);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
        { pubkey: statePDA,        isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
        { pubkey: depositor,       isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(ix),
      [admin]
    );
  }

  async fetchEscrowState(escrowId: string): Promise<EscrowStateData | null> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, escrowId);
    const info = await this.connection.getAccountInfo(statePDA);
    if (!info) return null;
    return deserializeEscrowState(Buffer.from(info.data));
  }

  async getVaultBalance(escrowId: string): Promise<number> {
    const [vaultPDA] = deriveVaultPDA(this.programId, escrowId);
    return (await this.connection.getBalance(vaultPDA)) / LAMPORTS_PER_SOL;
  }
}
