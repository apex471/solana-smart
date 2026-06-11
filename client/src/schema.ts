/**
 * Borsh serialization helpers mirroring the on-chain Rust types.
 * Manual implementation so it works in both Node and browser bundles.
 */

// ---------------------------------------------------------------------------
// Instruction discriminants (Borsh enum index)
// ---------------------------------------------------------------------------
export const enum InstructionType {
  CreateEscrow    = 0,
  Deposit         = 1,
  ClaimFunds      = 2,
  RaiseDispute    = 3,
  ResolveDispute  = 4,
  EmergencyRefund = 5,
}

// ---------------------------------------------------------------------------
// Low-level write helpers
// ---------------------------------------------------------------------------
function writeU8(buf: number[], v: number) { buf.push(v & 0xff); }
function writeU32LE(buf: number[], v: number) {
  buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}
function writeU64LE(buf: number[], v: bigint) {
  writeU32LE(buf, Number(v & 0xffffffffn));
  writeU32LE(buf, Number((v >> 32n) & 0xffffffffn));
}
function writeI64LE(buf: number[], v: bigint) { writeU64LE(buf, BigInt.asUintN(64, v)); }
function writeString(buf: number[], s: string) {
  const b = new TextEncoder().encode(s);
  writeU32LE(buf, b.length);
  b.forEach((x) => buf.push(x));
}
function writePubkey(buf: number[], key: Uint8Array) {
  key.forEach((x) => buf.push(x));
}
function writeBool(buf: number[], v: boolean) { buf.push(v ? 1 : 0); }

// ---------------------------------------------------------------------------
// Instruction encoders
// ---------------------------------------------------------------------------

export function encodeCreateEscrow(
  escrowId: string,
  recipient: Uint8Array,
  lockupSeconds: bigint,
  disputeWindowSeconds: bigint
): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.CreateEscrow);
  writeString(buf, escrowId);
  writePubkey(buf, recipient);
  writeI64LE(buf, lockupSeconds);
  writeI64LE(buf, disputeWindowSeconds);
  return Buffer.from(buf);
}

export function encodeDeposit(escrowId: string, amount: bigint): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.Deposit);
  writeString(buf, escrowId);
  writeU64LE(buf, amount);
  return Buffer.from(buf);
}

export function encodeClaimFunds(escrowId: string): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.ClaimFunds);
  writeString(buf, escrowId);
  return Buffer.from(buf);
}

export function encodeRaiseDispute(escrowId: string): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.RaiseDispute);
  writeString(buf, escrowId);
  return Buffer.from(buf);
}

export function encodeResolveDispute(
  escrowId: string,
  releaseToRecipient: boolean
): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.ResolveDispute);
  writeString(buf, escrowId);
  writeBool(buf, releaseToRecipient);
  return Buffer.from(buf);
}

export function encodeEmergencyRefund(escrowId: string): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.EmergencyRefund);
  writeString(buf, escrowId);
  return Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// EscrowStatus
// ---------------------------------------------------------------------------

export enum EscrowStatus {
  Pending   = 0,
  Active    = 1,
  Disputed  = 2,
  Released  = 3,
  Refunded  = 4,
}

export const ESCROW_STATUS_LABELS: Record<EscrowStatus, string> = {
  [EscrowStatus.Pending]:  "Pending",
  [EscrowStatus.Active]:   "Active",
  [EscrowStatus.Disputed]: "Disputed",
  [EscrowStatus.Released]: "Released",
  [EscrowStatus.Refunded]: "Refunded",
};

// ---------------------------------------------------------------------------
// EscrowState deserialization
// ---------------------------------------------------------------------------

export interface EscrowStateData {
  discriminator: number;
  admin:         string;
  depositor:     string;
  recipient:     string;
  amount:        bigint;
  status:        EscrowStatus;
  escrowId:      string;
  createdAt:     bigint;
  releaseAfter:  bigint;
  disputeWindow: bigint;
  bump:          number;
}

function readU8(data: Uint8Array, off: number): [number, number] {
  return [data[off], off + 1];
}
function readU64LE(data: Uint8Array, off: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(data[off + i]) << BigInt(i * 8);
  return [v, off + 8];
}
function readI64LE(data: Uint8Array, off: number): [bigint, number] {
  const [u, next] = readU64LE(data, off);
  // sign-extend if high bit set
  return [u >= 0x8000000000000000n ? u - 0x10000000000000000n : u, next];
}
function readPubkey(data: Uint8Array, off: number): [string, number] {
  const { PublicKey } = require("@solana/web3.js");
  return [new PublicKey(data.slice(off, off + 32)).toBase58(), off + 32];
}

export function deserializeEscrowState(data: Buffer): EscrowStateData {
  let off = 0;

  let discriminator: number;  [discriminator, off] = readU8(data, off);
  let admin: string;          [admin,         off] = readPubkey(data, off);
  let depositor: string;      [depositor,     off] = readPubkey(data, off);
  let recipient: string;      [recipient,     off] = readPubkey(data, off);
  let amount: bigint;         [amount,        off] = readU64LE(data, off);
  let statusByte: number;     [statusByte,    off] = readU8(data, off);

  const idBytes = data.slice(off, off + 32);
  off += 32;
  const nullIdx = idBytes.indexOf(0);
  const escrowId = new TextDecoder().decode(nullIdx === -1 ? idBytes : idBytes.slice(0, nullIdx));

  let createdAt: bigint;      [createdAt,     off] = readI64LE(data, off);
  let releaseAfter: bigint;   [releaseAfter,  off] = readI64LE(data, off);
  let disputeWindow: bigint;  [disputeWindow, off] = readI64LE(data, off);
  let bump: number;           [bump]               = readU8(data, off);

  return {
    discriminator,
    admin,
    depositor,
    recipient,
    amount,
    status: statusByte as EscrowStatus,
    escrowId,
    createdAt,
    releaseAfter,
    disputeWindow,
    bump,
  };
}
