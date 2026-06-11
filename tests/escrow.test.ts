/**
 * Integration tests for the Solana Escrow program.
 *
 * Run against a local validator:
 *   solana-test-validator &
 *   solana program deploy program/target/deploy/solana_escrow.so --program-id <keypair>
 *   yarn test
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Config — set PROGRAM_ID env var to your deployed ID
// ---------------------------------------------------------------------------
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "EscroW1111111111111111111111111111111111111111"
);

const connection = new Connection(RPC, "confirmed");

// ---------------------------------------------------------------------------
// Helpers (inline serialisation — mirrors client/src/schema.ts)
// ---------------------------------------------------------------------------
function padId(id: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(id.slice(0, 32)).copy(b);
  return b;
}
function pda(prefix: string, id: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), padId(id)], PROGRAM_ID)[0];
}

function u8(v: number): number[] { return [v & 0xff]; }
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
function u64le(v: bigint): number[] {
  return [...u32le(Number(v & 0xffffffffn)), ...u32le(Number((v >> 32n) & 0xffffffffn))];
}
function str(s: string): number[] {
  const b = Array.from(new TextEncoder().encode(s));
  return [...u32le(b.length), ...b];
}

function buildCreateEscrow(escrowId: string, recipient: PublicKey): Buffer {
  return Buffer.from([...u8(0), ...str(escrowId), ...Array.from(recipient.toBytes())]);
}
function buildDeposit(escrowId: string, lamports: bigint): Buffer {
  return Buffer.from([...u8(1), ...str(escrowId), ...u64le(lamports)]);
}
function buildRelease(escrowId: string): Buffer {
  return Buffer.from([...u8(2), ...str(escrowId)]);
}
function buildRefund(escrowId: string): Buffer {
  return Buffer.from([...u8(3), ...str(escrowId)]);
}

async function airdrop(kp: Keypair, sol = 2) {
  const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Escrow Program", () => {
  let admin: Keypair;
  let depositor: Keypair;
  let recipient: Keypair;
  const escrowId = `test-${Date.now()}`;

  beforeAll(async () => {
    admin = Keypair.generate();
    depositor = Keypair.generate();
    recipient = Keypair.generate();
    await Promise.all([airdrop(admin, 2), airdrop(depositor, 2)]);
  }, 30_000);

  test("admin creates escrow", async () => {
    const statePDA = pda("escrow", escrowId);
    const vaultPDA = pda("vault", escrowId);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildCreateEscrow(escrowId, recipient.publicKey),
    });

    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [admin]
    );
    expect(sig).toBeDefined();

    const info = await connection.getAccountInfo(statePDA);
    expect(info).not.toBeNull();
    expect(info!.data[0]).toBe(1); // discriminator
    expect(info!.data[148 - 1]).toBeDefined(); // bump byte present
  }, 30_000);

  test("depositor funds the escrow", async () => {
    const statePDA = pda("escrow", escrowId);
    const vaultPDA = pda("vault", escrowId);
    const depositLamports = BigInt(0.5 * LAMPORTS_PER_SOL);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildDeposit(escrowId, depositLamports),
    });

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [depositor]
    );

    const vaultBalance = await connection.getBalance(vaultPDA);
    expect(vaultBalance).toBe(Number(depositLamports));
  }, 30_000);

  test("admin releases funds to recipient", async () => {
    const statePDA = pda("escrow", escrowId);
    const vaultPDA = pda("vault", escrowId);
    const beforeBalance = await connection.getBalance(recipient.publicKey);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildRelease(escrowId),
    });

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [admin]
    );

    const afterBalance = await connection.getBalance(recipient.publicKey);
    expect(afterBalance).toBeGreaterThan(beforeBalance);

    // Vault should be drained
    const vaultBalance = await connection.getBalance(vaultPDA);
    expect(vaultBalance).toBe(0);
  }, 30_000);

  test("refund flow — creates separate escrow and refunds depositor", async () => {
    const rid = `refund-${Date.now()}`;
    const statePDA = pda("escrow", rid);
    const vaultPDA = pda("vault", rid);
    const depositLamports = BigInt(0.3 * LAMPORTS_PER_SOL);

    // Create
    const createIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildCreateEscrow(rid, recipient.publicKey),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [admin]);

    // Deposit
    const depositIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildDeposit(rid, depositLamports),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(depositIx), [depositor]);

    const depositorBefore = await connection.getBalance(depositor.publicKey);

    // Refund
    const refundIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: statePDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: depositor.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: buildRefund(rid),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [admin]);

    const depositorAfter = await connection.getBalance(depositor.publicKey);
    expect(depositorAfter).toBeGreaterThan(depositorBefore);
  }, 60_000);
});
