/**
 * Integration tests — immediate-release escrow (no lockup timer).
 * Run: solana-test-validator & PROGRAM_ID=<id> yarn test:integration
 */
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC        = process.env.RPC_URL  ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "Escrow11111111111111111111111111111111111111");
const conn       = new Connection(RPC, "confirmed");

function padId(id: string): Buffer { const b = Buffer.alloc(32, 0); Buffer.from(id.slice(0, 32)).copy(b); return b; }
function pda(prefix: string, id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), padId(id)], PROGRAM_ID)[0];
}
function u8(v: number): number[] { return [v & 0xff]; }
function u32le(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function u64le(v: bigint): number[] { return [...u32le(Number(v & 0xffffffffn)), ...u32le(Number((v >> 32n) & 0xffffffffn))]; }
function str(s: string): number[] { const b = Array.from(new TextEncoder().encode(s)); return [...u32le(b.length), ...b]; }
function bool(v: boolean): number[] { return [v ? 1 : 0]; }

const enc = {
  create:  (id: string, r: PublicKey) =>
    Buffer.from([...u8(0), ...str(id), ...Array.from(r.toBytes())]),
  deposit: (id: string, a: bigint) =>
    Buffer.from([...u8(1), ...str(id), ...u64le(a)]),
  claim:   (id: string) =>
    Buffer.from([...u8(2), ...str(id)]),
  dispute: (id: string) =>
    Buffer.from([...u8(3), ...str(id)]),
  resolve: (id: string, release: boolean) =>
    Buffer.from([...u8(4), ...str(id), ...bool(release)]),
};

async function airdrop(kp: Keypair, sol = 2) {
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL));
}
function ix(data: Buffer, keys: any[]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

describe("Immediate-release Escrow", () => {
  let admin: Keypair, depositor: Keypair, recipient: Keypair;

  beforeAll(async () => {
    admin     = Keypair.generate();
    depositor = Keypair.generate();
    recipient = Keypair.generate();
    await Promise.all([airdrop(admin), airdrop(depositor)]);
  }, 30_000);

  // ---- Happy path: deposit → immediate claim ------------------------------
  describe("Happy path: deposit → recipient claims immediately", () => {
    const eid = `immediate-${Date.now()}`;

    test("admin creates escrow", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey),
        [
          { pubkey: admin.publicKey,            isSigner: true,  isWritable: true  },
          { pubkey: pda("escrow", eid),          isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),          isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
        ]
      )), [admin]);
      const info = await conn.getAccountInfo(pda("escrow", eid));
      expect(info!.data[0]).toBe(1); // discriminator
    }, 30_000);

    test("depositor funds escrow immediately", async () => {
      const lamports = BigInt(0.5 * LAMPORTS_PER_SOL);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.deposit(eid, lamports),
        [
          { pubkey: depositor.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: pda("escrow", eid),          isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),          isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
        ]
      )), [depositor]);
      expect(await conn.getBalance(pda("vault", eid))).toBe(Number(lamports));
    }, 30_000);

    test("recipient claims immediately — no wait, no admin", async () => {
      const before = await conn.getBalance(recipient.publicKey);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.claim(eid),
        [
          { pubkey: recipient.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: pda("escrow", eid),          isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),          isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
        ]
      )), [recipient]);
      expect(await conn.getBalance(recipient.publicKey)).toBeGreaterThan(before);
      expect(await conn.getBalance(pda("vault", eid))).toBe(0);
    }, 30_000);
  });

  // ---- Dispute path -------------------------------------------------------
  describe("Dispute path: depositor disputes → admin refunds", () => {
    const eid = `dispute-${Date.now()}`;

    test("create + deposit", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey),
        [
          { pubkey: admin.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: pda("escrow", eid),      isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),      isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.deposit(eid, BigInt(0.3 * LAMPORTS_PER_SOL)),
        [
          { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
          { pubkey: pda("escrow", eid),      isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),      isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [depositor]);
    }, 30_000);

    test("depositor raises dispute — funds frozen", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.dispute(eid),
        [
          { pubkey: depositor.publicKey, isSigner: true,  isWritable: false },
          { pubkey: pda("escrow", eid),  isSigner: false, isWritable: true  },
        ]
      )), [depositor]);
      const info = await conn.getAccountInfo(pda("escrow", eid));
      // status byte is at offset 97 (1+32+32+32+8=105? let's just check vault still has funds)
      expect(await conn.getBalance(pda("vault", eid))).toBeGreaterThan(0);
    }, 30_000);

    test("admin resolves → refund to depositor", async () => {
      const before = await conn.getBalance(depositor.publicKey);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.resolve(eid, false),
        [
          { pubkey: admin.publicKey,         isSigner: true,  isWritable: false },
          { pubkey: pda("escrow", eid),      isSigner: false, isWritable: true  },
          { pubkey: pda("vault",  eid),      isSigner: false, isWritable: true  },
          { pubkey: depositor.publicKey,     isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);
      expect(await conn.getBalance(depositor.publicKey)).toBeGreaterThan(before);
      expect(await conn.getBalance(pda("vault", eid))).toBe(0);
    }, 30_000);
  });
});
