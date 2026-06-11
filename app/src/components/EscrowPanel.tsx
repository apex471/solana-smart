import React, { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Inline Borsh helpers (avoids bundler headaches with the Node SDK)
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number) {
  buf.push(v & 0xff);
}
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

function encodeDeposit(escrowId: string, lamports: bigint): Buffer {
  const buf: number[] = [];
  writeU8(buf, 1); // Deposit discriminant
  writeString(buf, escrowId);
  writeU64LE(buf, lamports);
  return Buffer.from(buf);
}

function padEscrowId(escrowId: string): Buffer {
  const b = Buffer.alloc(32, 0);
  const src = Buffer.from(escrowId.slice(0, 32));
  src.copy(b);
  return b;
}

function derivePDA(programId: PublicKey, prefix: string, escrowId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(prefix), padEscrowId(escrowId)],
    programId
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ESCROW_STATUS_LABELS: Record<number, string> = {
  0: "Pending",
  1: "Active — funds locked",
  2: "Released",
  3: "Refunded",
};

type Phase = "idle" | "depositing" | "active" | "released" | "refunded";

interface EscrowInfo {
  escrowId: string;
  admin: string;
  recipient: string;
  amountSol: number;
  status: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  programId: PublicKey;
  /** Admin keypair — in production this would be the server-side authority */
  adminKeypair: Keypair;
}

export const EscrowPanel: React.FC<Props> = ({ programId, adminKeypair }) => {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [escrowId, setEscrowId] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [escrowInfo, setEscrowInfo] = useState<EscrowInfo | null>(null);
  const [vaultBalance, setVaultBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const log = (msg: string) => setStatus(msg);

  // -------------------------------------------------------------------------
  // Fetch current escrow state
  // -------------------------------------------------------------------------
  const refreshEscrow = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const statePDA = derivePDA(programId, "escrow", id);
        const vaultPDA = derivePDA(programId, "vault", id);

        const [stateInfo, vaultLamports] = await Promise.all([
          connection.getAccountInfo(statePDA),
          connection.getBalance(vaultPDA),
        ]);

        if (!stateInfo) {
          setEscrowInfo(null);
          setVaultBalance(null);
          return;
        }

        const d = Buffer.from(stateInfo.data);
        let off = 1; // skip discriminator

        const readPK = () => {
          const pk = new PublicKey(d.slice(off, off + 32)).toBase58();
          off += 32;
          return pk;
        };
        const readU64 = () => {
          let v = 0n;
          for (let i = 0; i < 8; i++) v |= BigInt(d[off + i]) << BigInt(i * 8);
          off += 8;
          return v;
        };

        const admin = readPK();
        readPK(); // depositor
        const recipient = readPK();
        const amount = readU64();
        const escrowStatus = d[off++];
        off += 32; // escrow_id bytes
        const createdAt = Number(readU64());

        setEscrowInfo({
          escrowId: id,
          admin,
          recipient,
          amountSol: Number(amount) / LAMPORTS_PER_SOL,
          status: escrowStatus,
          createdAt,
        });
        setVaultBalance(vaultLamports / LAMPORTS_PER_SOL);
      } catch {
        setEscrowInfo(null);
      }
    },
    [connection, programId]
  );

  useEffect(() => {
    if (escrowId) refreshEscrow(escrowId);
  }, [escrowId, refreshEscrow]);

  // -------------------------------------------------------------------------
  // Deposit — user connects wallet and funds the escrow immediately
  // -------------------------------------------------------------------------
  const handleDeposit = async () => {
    if (!publicKey) return log("Connect your wallet first.");
    if (!escrowId) return log("Enter an escrow ID.");
    const amount = parseFloat(amountInput);
    if (isNaN(amount) || amount <= 0) return log("Enter a valid SOL amount.");

    setLoading(true);
    try {
      const vaultPDA = derivePDA(programId, "vault", escrowId);
      const statePDA = derivePDA(programId, "escrow", escrowId);
      const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

      const data = encodeDeposit(escrowId, lamports);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: statePDA, isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      log(`Deposit confirmed! Tx: ${sig}`);
      await refreshEscrow(escrowId);
    } catch (e: any) {
      log(`Deposit failed: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  return (
    <div className="escrow-panel">
      <h2>Escrow Contract</h2>

      <div className="field-group">
        <label>Escrow ID</label>
        <input
          value={escrowId}
          onChange={(e) => setEscrowId(e.target.value)}
          placeholder="e.g. job-2024-001"
          maxLength={32}
        />
      </div>

      {escrowInfo ? (
        <div className="escrow-info">
          <h3>Escrow Status</h3>
          <div className={`status-badge status-${escrowInfo.status}`}>
            {ESCROW_STATUS_LABELS[escrowInfo.status] ?? "Unknown"}
          </div>
          <table>
            <tbody>
              <tr>
                <td>Admin</td>
                <td className="mono">{escrowInfo.admin.slice(0, 16)}…</td>
              </tr>
              <tr>
                <td>Recipient</td>
                <td className="mono">{escrowInfo.recipient.slice(0, 16)}…</td>
              </tr>
              <tr>
                <td>Locked Amount</td>
                <td>{escrowInfo.amountSol.toFixed(4)} SOL</td>
              </tr>
              <tr>
                <td>Vault Balance</td>
                <td>{vaultBalance?.toFixed(4) ?? "—"} SOL</td>
              </tr>
              <tr>
                <td>Created</td>
                <td>{new Date(escrowInfo.createdAt * 1000).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        escrowId && (
          <p className="no-escrow">No escrow found for ID "{escrowId}"</p>
        )
      )}

      {/* Only show deposit form when escrow is Pending */}
      {(!escrowInfo || escrowInfo.status === 0) && (
        <div className="deposit-section">
          <h3>Fund This Escrow</h3>
          <p className="hint">
            Funds are transferred immediately to the admin vault and held until
            the contract ends.
          </p>
          <div className="field-group">
            <label>Amount (SOL)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="0.5"
            />
          </div>
          <button
            className="btn-primary"
            onClick={handleDeposit}
            disabled={loading || !publicKey}
          >
            {loading ? "Sending…" : "Deposit & Lock Funds"}
          </button>
          {!publicKey && (
            <p className="warn">Connect your wallet above to deposit.</p>
          )}
        </div>
      )}

      {escrowInfo?.status === 1 && (
        <div className="active-notice">
          <span>⚡</span> Work is in progress. Funds are securely locked.
          The admin will release payment on completion.
        </div>
      )}

      {escrowInfo?.status === 2 && (
        <div className="success-notice">
          Payment released to recipient.
        </div>
      )}

      {escrowInfo?.status === 3 && (
        <div className="refund-notice">
          Funds refunded to depositor.
        </div>
      )}

      {status && <p className="status-msg">{status}</p>}
    </div>
  );
};
