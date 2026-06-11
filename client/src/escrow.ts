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
  encodeCreateEscrow,
  encodeDeposit,
  encodeReleaseFunds,
  encodeRefund,
} from "./schema";

export { EscrowStatus, ESCROW_STATUS_LABELS };
export type { EscrowStateData };

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export async function deriveEscrowStatePDA(
  programId: PublicKey,
  escrowId: string
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), Buffer.from(escrowId.padEnd(32, "\0").slice(0, 32))],
    programId
  );
}

export async function deriveVaultPDA(
  programId: PublicKey,
  escrowId: string
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(escrowId.padEnd(32, "\0").slice(0, 32))],
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

  // -------------------------------------------------------------------------
  // createEscrow — admin creates an escrow slot
  // -------------------------------------------------------------------------
  async createEscrow(
    admin: Keypair,
    escrowId: string,
    recipient: PublicKey
  ): Promise<string> {
    const [escrowStatePDA] = await deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = await deriveVaultPDA(this.programId, escrowId);

    const data = encodeCreateEscrow(escrowId, recipient.toBytes());

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowStatePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [admin]);
  }

  // -------------------------------------------------------------------------
  // deposit — user funds the escrow (Pending → Active)
  // -------------------------------------------------------------------------
  async deposit(
    depositor: Keypair,
    escrowId: string,
    amountSol: number
  ): Promise<string> {
    const [escrowStatePDA] = await deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = await deriveVaultPDA(this.programId, escrowId);
    const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

    const data = encodeDeposit(escrowId, lamports);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowStatePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [depositor]);
  }

  // -------------------------------------------------------------------------
  // releaseFunds — admin releases vault to recipient (Active → Released)
  // -------------------------------------------------------------------------
  async releaseFunds(
    admin: Keypair,
    escrowId: string,
    recipient: PublicKey
  ): Promise<string> {
    const [escrowStatePDA] = await deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = await deriveVaultPDA(this.programId, escrowId);

    const data = encodeReleaseFunds(escrowId);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowStatePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [admin]);
  }

  // -------------------------------------------------------------------------
  // refund — admin refunds vault to depositor (Active → Refunded)
  // -------------------------------------------------------------------------
  async refund(
    admin: Keypair,
    escrowId: string,
    depositor: PublicKey
  ): Promise<string> {
    const [escrowStatePDA] = await deriveEscrowStatePDA(this.programId, escrowId);
    const [vaultPDA] = await deriveVaultPDA(this.programId, escrowId);

    const data = encodeRefund(escrowId);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowStatePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: depositor, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [admin]);
  }

  // -------------------------------------------------------------------------
  // fetchEscrowState — read current on-chain state
  // -------------------------------------------------------------------------
  async fetchEscrowState(escrowId: string): Promise<EscrowStateData | null> {
    const [escrowStatePDA] = await deriveEscrowStatePDA(this.programId, escrowId);
    const accountInfo = await this.connection.getAccountInfo(escrowStatePDA);
    if (!accountInfo) return null;
    return deserializeEscrowState(Buffer.from(accountInfo.data));
  }

  // -------------------------------------------------------------------------
  // getVaultBalance — SOL held in the vault
  // -------------------------------------------------------------------------
  async getVaultBalance(escrowId: string): Promise<number> {
    const [vaultPDA] = await deriveVaultPDA(this.programId, escrowId);
    const lamports = await this.connection.getBalance(vaultPDA);
    return lamports / LAMPORTS_PER_SOL;
  }
}
