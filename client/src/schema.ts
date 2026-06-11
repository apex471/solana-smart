function writeU8(buf: number[], v: number) { buf.push(v & 0xff); }
function writeU32LE(buf: number[], v: number) {
  buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}
function writeU64LE(buf: number[], v: bigint) {
  writeU32LE(buf, Number(v & 0xffffffffn));
  writeU32LE(buf, Number((v >> 32n) & 0xffffffffn));
}
function writeString(buf: number[], s: string) {
  const b = new TextEncoder().encode(s);
  writeU32LE(buf, b.length);
  b.forEach((x) => buf.push(x));
}
function writePubkey(buf: number[], key: Uint8Array) { key.forEach((x) => buf.push(x)); }

export function encodeCreateEscrow(id: string, recipient: Uint8Array, amount: bigint): Buffer {
  const b: number[] = [];
  writeU8(b, 0); writeString(b, id); writePubkey(b, recipient); writeU64LE(b, amount);
  return Buffer.from(b);
}

export function encodeDeposit(id: string): Buffer {
  const b: number[] = [];
  writeU8(b, 1); writeString(b, id);
  return Buffer.from(b);
}

export function encodeCancelEscrow(id: string): Buffer {
  const b: number[] = [];
  writeU8(b, 2); writeString(b, id);
  return Buffer.from(b);
}

export enum EscrowStatus {
  Pending   = 0,
  Released  = 1,
  Cancelled = 2,
  Refunded  = 3,
}

export const ESCROW_STATUS_LABELS: Record<EscrowStatus, string> = {
  [EscrowStatus.Pending]:   "Pending",
  [EscrowStatus.Released]:  "Released",
  [EscrowStatus.Cancelled]: "Cancelled",
  [EscrowStatus.Refunded]:  "Refunded",
};

export interface EscrowStateData {
  discriminator: number;
  admin:         string;
  depositor:     string;
  recipient:     string;
  amount:        bigint;
  status:        EscrowStatus;
  escrowId:      string;
  createdAt:     bigint;
  bump:          number;
}

function readU8(d: Uint8Array, o: number): [number, number] { return [d[o], o + 1]; }
function readU64LE(d: Uint8Array, o: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(d[o + i]) << BigInt(i * 8);
  return [v, o + 8];
}
function readPubkey(d: Uint8Array, o: number): [string, number] {
  const { PublicKey } = require("@solana/web3.js");
  return [new PublicKey(d.slice(o, o + 32)).toBase58(), o + 32];
}

export function deserializeEscrowState(data: Buffer): EscrowStateData {
  let o = 0;
  let discriminator: number; [discriminator, o] = readU8(data, o);
  let admin: string;         [admin,         o] = readPubkey(data, o);
  let depositor: string;     [depositor,     o] = readPubkey(data, o);
  let recipient: string;     [recipient,     o] = readPubkey(data, o);
  let amount: bigint;        [amount,        o] = readU64LE(data, o);
  let sb: number;            [sb,            o] = readU8(data, o);
  const idBytes = data.slice(o, o + 32); o += 32;
  const ni      = idBytes.indexOf(0);
  const escrowId = new TextDecoder().decode(ni === -1 ? idBytes : idBytes.slice(0, ni));
  let createdAt: bigint;     [createdAt,     o] = readU64LE(data, o);
  let bump: number;          [bump]             = readU8(data, o);
  return { discriminator, admin, depositor, recipient, amount, status: sb as EscrowStatus, escrowId, createdAt, bump };
}
