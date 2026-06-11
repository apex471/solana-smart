import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  EscrowStateData, EscrowStatus, ESCROW_STATUS_LABELS, deserializeEscrowState,
  encodeClaimFunds, encodeCreateEscrow, encodeDeposit,
  encodeEmergencyRefund, encodeRaiseDispute, encodeResolveDispute,
} from "./schema";

export { EscrowStatus, ESCROW_STATUS_LABELS };
export type { EscrowStateData };

function padId(id: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(id.slice(0, 32)).copy(b);
  return b;
}

export function deriveEscrowStatePDA(programId: PublicKey, id: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), padId(id)], programId);
}
export function deriveVaultPDA(programId: PublicKey, id: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), padId(id)], programId);
}

export class EscrowClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey
  ) {}

  /** Admin creates an escrow slot. */
  async createEscrow(admin: Keypair, id: string, recipient: PublicKey): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,        isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeCreateEscrow(id, recipient.toBytes()),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [admin]);
  }

  /** Depositor locks funds. Recipient can claim immediately after. */
  async deposit(depositor: Keypair, id: string, amountSol: number): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeDeposit(id, BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL))),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [depositor]);
  }

  /** Recipient claims funds — available immediately, no timer. */
  async claimFunds(recipient: Keypair, id: string): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: recipient.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeClaimFunds(id),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [recipient]);
  }

  /** Depositor raises a dispute — freezes funds while Active. */
  async raiseDispute(depositor: Keypair, id: string): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true,  isWritable: false },
        { pubkey: statePDA,            isSigner: false, isWritable: true  },
      ],
      data: encodeRaiseDispute(id),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [depositor]);
  }

  /** Admin resolves a disputed escrow. */
  async resolveDispute(admin: Keypair, id: string, releaseToRecipient: boolean, payoutPubkey: PublicKey): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey,  isSigner: true,  isWritable: false },
        { pubkey: statePDA,         isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,         isSigner: false, isWritable: true  },
        { pubkey: payoutPubkey,     isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeResolveDispute(id, releaseToRecipient),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [admin]);
  }

  /** Admin emergency refund. */
  async emergencyRefund(admin: Keypair, id: string, depositor: PublicKey): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
        { pubkey: statePDA,        isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
        { pubkey: depositor,       isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeEmergencyRefund(id),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [admin]);
  }

  async fetchEscrowState(id: string): Promise<EscrowStateData | null> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const info = await this.connection.getAccountInfo(statePDA);
    if (!info) return null;
    return deserializeEscrowState(Buffer.from(info.data));
  }

  async getVaultBalance(id: string): Promise<number> {
    const [vaultPDA] = deriveVaultPDA(this.programId, id);
    return (await this.connection.getBalance(vaultPDA)) / LAMPORTS_PER_SOL;
  }
}
