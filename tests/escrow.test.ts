/**
 * Integration tests for the Solana Escrow program (optimistic auto-release).
 *
 * Run against a local validator:
 *   solana-test-validator &
 *   PROGRAM_ID=<deployed-id> yarn test:integration
 */

import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  Transaction, TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC        = process.env.RPC_URL  ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "Escrow11111111111111111111111111111111111111");
const conn       = new Connection(RPC, "confirmed");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function padId(id: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(id.slice(0, 32)).copy(b);
  return b;
}
function pda(prefix: string, id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), padId(id)], PROGRAM_ID)[0];
}
function u8(v: number): number[]  { return [v & 0xff]; }
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
function bool(v: boolean): number[] { return [v ? 1 : 0]; }

const enc = {
  create: (id: string, recipient: PublicKey, lockup: bigint, dw: bigint) =>
    Buffer.from([...u8(0), ...str(id), ...Array.from(recipient.toBytes()), ...u64le(lockup), ...u64le(dw)]),
  deposit: (id: string, amt: bigint) =>
    Buffer.from([...u8(1), ...str(id), ...u64le(amt)]),
  claim: (id: string) =>
    Buffer.from([...u8(2), ...str(id)]),
  dispute: (id: string) =>
    Buffer.from([...u8(3), ...str(id)]),
  resolve: (id: string, release: boolean) =>
    Buffer.from([...u8(4), ...str(id), ...bool(release)]),
  emergency: (id: string) =>
    Buffer.from([...u8(5), ...str(id)]),
};

async function airdrop(kp: Keypair, sol = 2) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig);
}
function ix(data: Buffer, keys: Parameters<typeof TransactionInstruction>[0]["keys"]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Optimistic Escrow", () => {
  let admin: Keypair, depositor: Keypair, recipient: Keypair;

  beforeAll(async () => {
    admin     = Keypair.generate();
    depositor = Keypair.generate();
    recipient = Keypair.generate();
    await Promise.all([airdrop(admin), airdrop(depositor)]);
  }, 30_000);

  // ---- Happy path: deposit → auto-claim ----------------------------------
  describe("Happy path: deposit → auto-claim (no admin)", () => {
    const eid = `auto-${Date.now()}`;

    test("admin creates escrow (2s lockup, 1s dispute window)", async () => {
      const statePDA = pda("escrow", eid);
      const vaultPDA = pda("vault",  eid);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey, 2n, 1n),
        [
          { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,        isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);

      const info = await conn.getAccountInfo(statePDA);
      expect(info).not.toBeNull();
      expect(info!.data[0]).toBe(1); // discriminator
    }, 30_000);

    test("depositor funds escrow immediately", async () => {
      const statePDA = pda("escrow", eid);
      const vaultPDA = pda("vault",  eid);
      const lamports = BigInt(0.5 * LAMPORTS_PER_SOL);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.deposit(eid, lamports),
        [
          { pubkey: depositor.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,            isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [depositor]);

      expect(await conn.getBalance(vaultPDA)).toBe(Number(lamports));
    }, 30_000);

    test("recipient claims after lockup — no admin needed", async () => {
      // Wait for the 2-second lockup
      await new Promise((r) => setTimeout(r, 3000));

      const statePDA  = pda("escrow", eid);
      const vaultPDA  = pda("vault",  eid);
      const before    = await conn.getBalance(recipient.publicKey);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.claim(eid),
        [
          { pubkey: recipient.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,            isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [recipient]);

      expect(await conn.getBalance(recipient.publicKey)).toBeGreaterThan(before);
      expect(await conn.getBalance(vaultPDA)).toBe(0);
    }, 30_000);
  });

  // ---- Dispute path -------------------------------------------------------
  describe("Dispute path: deposit → dispute → admin resolves refund", () => {
    const eid = `dispute-${Date.now()}`;

    test("create + deposit", async () => {
      const statePDA = pda("escrow", eid);
      const vaultPDA = pda("vault",  eid);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey, 60n, 30n), // 60s lockup, 30s dispute
        [
          { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,        isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,        isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.deposit(eid, BigInt(0.3 * LAMPORTS_PER_SOL)),
        [
          { pubkey: depositor.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,            isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [depositor]);
    }, 30_000);

    test("depositor raises dispute", async () => {
      const statePDA = pda("escrow", eid);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.dispute(eid),
        [
          { pubkey: depositor.publicKey, isSigner: true,  isWritable: false },
          { pubkey: statePDA,            isSigner: false, isWritable: true  },
        ]
      )), [depositor]);

      const info = await conn.getAccountInfo(statePDA);
      expect(info!.data[97]).toBe(2); // status byte = Disputed
    }, 30_000);

    test("admin resolves dispute as refund", async () => {
      const statePDA = pda("escrow", eid);
      const vaultPDA = pda("vault",  eid);
      const before   = await conn.getBalance(depositor.publicKey);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.resolve(eid, false), // false = refund depositor
        [
          { pubkey: admin.publicKey,     isSigner: true,  isWritable: false },
          { pubkey: statePDA,            isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,            isSigner: false, isWritable: true  },
          { pubkey: depositor.publicKey, isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);

      expect(await conn.getBalance(depositor.publicKey)).toBeGreaterThan(before);
      expect(await conn.getBalance(vaultPDA)).toBe(0);
    }, 30_000);
  });
});
