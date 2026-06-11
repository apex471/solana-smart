/**
 * Integration tests — direct-transfer escrow (v4).
 * Admin creates escrow with pre-set recipient. Depositor approves & pays in one tx.
 * Funds go directly depositor → recipient. No vault. No claim step.
 *
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
function escrowPDA(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), padId(id)], PROGRAM_ID)[0];
}
function u8(v: number): number[] { return [v & 0xff]; }
function u32le(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function u64le(v: bigint): number[] { return [...u32le(Number(v & 0xffffffffn)), ...u32le(Number((v >> 32n) & 0xffffffffn))]; }
function str(s: string): number[] { const b = Array.from(new TextEncoder().encode(s)); return [...u32le(b.length), ...b]; }

const enc = {
  create:  (id: string, r: PublicKey) =>
    Buffer.from([...u8(0), ...str(id), ...Array.from(r.toBytes())]),
  deposit: (id: string, a: bigint) =>
    Buffer.from([...u8(1), ...str(id), ...u64le(a)]),
  cancel:  (id: string) =>
    Buffer.from([...u8(2), ...str(id)]),
};

async function airdrop(kp: Keypair, sol = 2) {
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL));
}
function ix(data: Buffer, keys: any[]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

describe("Direct-transfer Escrow", () => {
  let admin: Keypair, depositor: Keypair, recipient: Keypair;

  beforeAll(async () => {
    admin     = Keypair.generate();
    depositor = Keypair.generate();
    recipient = Keypair.generate();
    await Promise.all([airdrop(admin), airdrop(depositor)]);
  }, 30_000);

  // ---- Happy path: create → deposit → funds land on recipient in one tx ----
  describe("Happy path: deposit sends funds directly to recipient", () => {
    const eid = `direct-${Date.now()}`;

    test("admin creates escrow with recipient address", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey),
        [
          { pubkey: admin.publicKey,        isSigner: true,  isWritable: true  },
          { pubkey: escrowPDA(eid),         isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);

      const info = await conn.getAccountInfo(escrowPDA(eid));
      expect(info).not.toBeNull();
      expect(info!.data[0]).toBe(1); // discriminator
    }, 30_000);

    test("depositor approves → funds go directly to recipient (no vault)", async () => {
      const lamports = BigInt(Math.floor(0.5 * LAMPORTS_PER_SOL));
      const recipientBefore = await conn.getBalance(recipient.publicKey);

      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.deposit(eid, lamports),
        [
          { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
          { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
          { pubkey: recipient.publicKey,     isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [depositor]);

      // Recipient balance increased by exactly the deposited amount
      const recipientAfter = await conn.getBalance(recipient.publicKey);
      expect(recipientAfter - recipientBefore).toBe(Number(lamports));

      // State PDA records the completed escrow (no vault balance to check)
      const stateInfo = await conn.getAccountInfo(escrowPDA(eid));
      expect(stateInfo).not.toBeNull();
      // status byte: offset 1+32+32+32+8 = 105
      expect(stateInfo!.data[105]).toBe(1); // EscrowStatus::Released
    }, 30_000);

    test("second deposit is rejected — escrow already released", async () => {
      await expect(
        sendAndConfirmTransaction(conn, new Transaction().add(ix(
          enc.deposit(eid, BigInt(0.1 * LAMPORTS_PER_SOL)),
          [
            { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
            { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
            { pubkey: recipient.publicKey,     isSigner: false, isWritable: true  },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]
        )), [depositor])
      ).rejects.toThrow();
    }, 30_000);
  });

  // ---- Cancel path ---------------------------------------------------------
  describe("Cancel path: admin cancels a pending escrow", () => {
    const eid = `cancel-${Date.now()}`;

    test("admin creates escrow", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey),
        [
          { pubkey: admin.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);
    }, 30_000);

    test("admin cancels escrow → status Cancelled", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.cancel(eid),
        [
          { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
          { pubkey: escrowPDA(eid),  isSigner: false, isWritable: true  },
        ]
      )), [admin]);

      const info = await conn.getAccountInfo(escrowPDA(eid));
      expect(info!.data[105]).toBe(2); // EscrowStatus::Cancelled
    }, 30_000);

    test("deposit on cancelled escrow is rejected", async () => {
      await expect(
        sendAndConfirmTransaction(conn, new Transaction().add(ix(
          enc.deposit(eid, BigInt(0.1 * LAMPORTS_PER_SOL)),
          [
            { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
            { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
            { pubkey: recipient.publicKey,     isSigner: false, isWritable: true  },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]
        )), [depositor])
      ).rejects.toThrow();
    }, 30_000);
  });

  // ---- Wrong recipient guard -----------------------------------------------
  describe("Security: wrong recipient is rejected", () => {
    const eid = `wrongrec-${Date.now()}`;
    const imposter = Keypair.generate();

    test("admin creates escrow for real recipient", async () => {
      await sendAndConfirmTransaction(conn, new Transaction().add(ix(
        enc.create(eid, recipient.publicKey),
        [
          { pubkey: admin.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]
      )), [admin]);
    }, 30_000);

    test("deposit with imposter recipient address is rejected", async () => {
      await expect(
        sendAndConfirmTransaction(conn, new Transaction().add(ix(
          enc.deposit(eid, BigInt(0.1 * LAMPORTS_PER_SOL)),
          [
            { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
            { pubkey: escrowPDA(eid),          isSigner: false, isWritable: true  },
            { pubkey: imposter.publicKey,      isSigner: false, isWritable: true  }, // wrong!
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]
        )), [depositor])
      ).rejects.toThrow();
    }, 30_000);
  });
});
