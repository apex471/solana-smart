import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  EscrowStateData, EscrowStatus, ESCROW_STATUS_LABELS,
  deserializeEscrowState, encodeCreateEscrow, encodeDeposit, encodeCancelEscrow,
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

export class EscrowClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey
  ) {}

  /**
   * Admin creates an escrow slot with a pre-set recipient address.
   * Funds will be routed to this address the moment the depositor signs.
   */
  async createEscrow(admin: Keypair, id: string, recipient: PublicKey, amountSol: number): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const lamports   = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: statePDA,                    isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      ],
      data: encodeCreateEscrow(id, recipient.toBytes(), lamports),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [admin]);
  }

  /**
   * Depositor signs — amount is read from on-chain state set by admin.
   * No amount is passed or visible to the depositor.
   */
  async deposit(depositor: Keypair, id: string): Promise<string> {
    const state = await this.fetchEscrowState(id);
    if (!state) throw new Error(`Escrow "${id}" not found`);

    const [statePDA]  = deriveEscrowStatePDA(this.programId, id);
    const recipientPK = new PublicKey(state.recipient);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey,         isSigner: true,  isWritable: true  },
        { pubkey: statePDA,                    isSigner: false, isWritable: true  },
        { pubkey: recipientPK,                 isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      ],
      data: encodeDeposit(id),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [depositor]);
  }

  /** Admin cancels a Pending escrow before anyone deposits. */
  async cancelEscrow(admin: Keypair, id: string): Promise<string> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
        { pubkey: statePDA,        isSigner: false, isWritable: true  },
      ],
      data: encodeCancelEscrow(id),
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [admin]);
  }

  async fetchEscrowState(id: string): Promise<EscrowStateData | null> {
    const [statePDA] = deriveEscrowStatePDA(this.programId, id);
    const info = await this.connection.getAccountInfo(statePDA);
    if (!info) return null;
    return deserializeEscrowState(Buffer.from(info.data));
  }
}
