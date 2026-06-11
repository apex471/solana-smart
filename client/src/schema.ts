/**
 * Borsh serialization schemas mirroring the on-chain Rust types.
 * We use a manual approach compatible with borsh v2 for browser + Node.
 */

// ---------------------------------------------------------------------------
// EscrowInstruction discriminants (Borsh enum index)
// ---------------------------------------------------------------------------
export const enum InstructionType {
  CreateEscrow = 0,
  Deposit = 1,
  ReleaseFunds = 2,
  Refund = 3,
}

// ---------------------------------------------------------------------------
// Manual Borsh serialization helpers
// ---------------------------------------------------------------------------

function writeU8(buf: number[], value: number) {
  buf.push(value & 0xff);
}

function writeU32LE(buf: number[], value: number) {
  buf.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function writeU64LE(buf: number[], value: bigint) {
  const lo = Number(value & 0xffffffffn);
  const hi = Number((value >> 32n) & 0xffffffffn);
  writeU32LE(buf, lo);
  writeU32LE(buf, hi);
}

function writeString(buf: number[], str: string) {
  const bytes = new TextEncoder().encode(str);
  writeU32LE(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

function writePubkey(buf: number[], key: Uint8Array) {
  for (const b of key) buf.push(b);
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export function encodeCreateEscrow(escrowId: string, recipient: Uint8Array): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.CreateEscrow); // enum discriminant
  writeString(buf, escrowId);
  writePubkey(buf, recipient);
  return Buffer.from(buf);
}

export function encodeDeposit(escrowId: string, amount: bigint): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.Deposit);
  writeString(buf, escrowId);
  writeU64LE(buf, amount);
  return Buffer.from(buf);
}

export function encodeReleaseFunds(escrowId: string): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.ReleaseFunds);
  writeString(buf, escrowId);
  return Buffer.from(buf);
}

export function encodeRefund(escrowId: string): Buffer {
  const buf: number[] = [];
  writeU8(buf, InstructionType.Refund);
  writeString(buf, escrowId);
  return Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// EscrowState deserialization
// ---------------------------------------------------------------------------

export enum EscrowStatus {
  Pending = 0,
  Active = 1,
  Released = 2,
  Refunded = 3,
}

export const ESCROW_STATUS_LABELS: Record<EscrowStatus, string> = {
  [EscrowStatus.Pending]: "Pending",
  [EscrowStatus.Active]: "Active",
  [EscrowStatus.Released]: "Released",
  [EscrowStatus.Refunded]: "Refunded",
};

export interface EscrowStateData {
  discriminator: number;
  admin: string;
  depositor: string;
  recipient: string;
  amount: bigint;
  status: EscrowStatus;
  escrowId: string;
  createdAt: bigint;
  bump: number;
}

function readU8(data: Uint8Array, offset: number): [number, number] {
  return [data[offset], offset + 1];
}

function readU64LE(data: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8);
  }
  return [value, offset + 8];
}

function readPubkey(data: Uint8Array, offset: number): [string, number] {
  const { PublicKey } = require("@solana/web3.js");
  const bytes = data.slice(offset, offset + 32);
  return [new PublicKey(bytes).toBase58(), offset + 32];
}

export function deserializeEscrowState(data: Buffer): EscrowStateData {
  let offset = 0;

  let discriminator: number;
  [discriminator, offset] = readU8(data, offset);

  let admin: string;
  [admin, offset] = readPubkey(data, offset);

  let depositor: string;
  [depositor, offset] = readPubkey(data, offset);

  let recipient: string;
  [recipient, offset] = readPubkey(data, offset);

  let amount: bigint;
  [amount, offset] = readU64LE(data, offset);

  let statusByte: number;
  [statusByte, offset] = readU8(data, offset);
  const status = statusByte as EscrowStatus;

  const idBytes = data.slice(offset, offset + 32);
  offset += 32;
  const nullIdx = idBytes.indexOf(0);
  const escrowId = new TextDecoder().decode(
    nullIdx === -1 ? idBytes : idBytes.slice(0, nullIdx)
  );

  let createdAt: bigint;
  [createdAt, offset] = readU64LE(data, offset);

  let bump: number;
  [bump] = readU8(data, offset);

  return { discriminator, admin, depositor, recipient, amount, status, escrowId, createdAt, bump };
}
