import React, { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Borsh helpers
// ---------------------------------------------------------------------------
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
function padId(id: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(id.slice(0, 32)).copy(b);
  return b;
}
function escrowPDA(programId: PublicKey, id: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), padId(id)], programId)[0];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
const STATUS_LABELS: Record<number, string> = {
  0: "Pending — awaiting payment",
  1: "Released — payment sent",
  2: "Cancelled",
  3: "Refunded",
};

interface EscrowInfo {
  admin:      string;
  recipient:  string;
  depositor:  string;
  amountSol:  number;
  status:     number;
  createdAt:  number;
}

interface Props { programId: PublicKey; adminKeypair: Keypair; }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection }              = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [escrowId,    setEscrowId]    = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [info,        setInfo]        = useState<EscrowInfo | null>(null);
  const [statusMsg,   setStatusMsg]   = useState("");
  const [loading,     setLoading]     = useState(false);

  // ---- fetch escrow state -------------------------------------------------
  const refresh = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const statePDA = escrowPDA(programId, id);
      const si = await connection.getAccountInfo(statePDA);
      if (!si) { setInfo(null); return; }

      const d = Buffer.from(si.data);
      let o = 1;
      const rPK = () => { const pk = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32; return pk; };
      const rU64 = () => {
        let v = 0n;
        for (let i = 0; i < 8; i++) v |= BigInt(d[o + i]) << BigInt(i * 8);
        o += 8; return Number(v);
      };

      const admin     = rPK();
      const depositor = rPK();
      const recipient = rPK();
      const amount    = rU64();
      const status    = d[o++];
      o += 32; // escrow_id
      const createdAt = rU64();

      setInfo({ admin, depositor, recipient, amountSol: amount / LAMPORTS_PER_SOL, status, createdAt });
    } catch { setInfo(null); }
  }, [connection, programId]);

  useEffect(() => { if (escrowId) refresh(escrowId); }, [escrowId, refresh]);

  // ---- deposit & instant release ------------------------------------------
  const handleDeposit = async () => {
    if (!publicKey) return setStatusMsg("Connect your wallet first.");
    if (!info)      return setStatusMsg("Enter a valid escrow ID.");
    if (info.status !== 0) return setStatusMsg("This escrow is no longer pending.");

    const amount = parseFloat(amountInput);
    if (isNaN(amount) || amount <= 0) return setStatusMsg("Enter a valid SOL amount.");

    setLoading(true);
    try {
      const statePDA    = escrowPDA(programId, escrowId);
      const recipientPK = new PublicKey(info.recipient);
      const lamports    = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey,               isSigner: true,  isWritable: true  },
          { pubkey: statePDA,                isSigner: false, isWritable: true  },
          { pubkey: recipientPK,             isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...u8(1), ...str(escrowId), ...u64le(lamports)]),
      });

      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatusMsg(`Payment confirmed! Tx: ${sig.slice(0, 20)}…`);
      await refresh(escrowId);
    } catch (e: any) {
      setStatusMsg(`Transaction failed: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  // ---- derived ------------------------------------------------------------
  const isPending   = info?.status === 0;
  const isReleased  = info?.status === 1;
  const isCancelled = info?.status === 2;
  const noEscrow    = !info && !!escrowId;

  return (
    <div className="escrow-panel">
      <h2>Escrow Payment</h2>

      {/* Escrow ID lookup */}
      <div className="field-group">
        <label>Escrow ID</label>
        <input
          value={escrowId}
          onChange={(e) => setEscrowId(e.target.value)}
          placeholder="Enter escrow ID provided by admin"
          maxLength={32}
        />
      </div>

      {noEscrow && <p className="no-escrow">No escrow found for "{escrowId}"</p>}

      {/* Escrow summary card */}
      {info && (
        <div className="escrow-info">
          <div className={`status-badge status-${info.status}`}>
            {STATUS_LABELS[info.status]}
          </div>

          <table><tbody>
            <tr>
              <td>Recipient</td>
              <td className="mono highlight">{info.recipient}</td>
            </tr>
            <tr>
              <td>Admin</td>
              <td className="mono">{info.admin.slice(0, 20)}…</td>
            </tr>
            {info.depositor !== "11111111111111111111111111111111" && (
              <tr>
                <td>Paid by</td>
                <td className="mono">{info.depositor.slice(0, 20)}…</td>
              </tr>
            )}
            {info.amountSol > 0 && (
              <tr>
                <td>Amount paid</td>
                <td><strong>{info.amountSol.toFixed(4)} SOL</strong></td>
              </tr>
            )}
            <tr>
              <td>Created</td>
              <td>{new Date(info.createdAt * 1000).toLocaleString()}</td>
            </tr>
          </tbody></table>
        </div>
      )}

      {/* Payment form — only shown when pending */}
      {isPending && (
        <div className="action-section">
          <h3>Approve & Pay</h3>
          <p className="hint">
            Funds transfer <strong>directly to the recipient</strong> the moment
            you approve this transaction. No waiting, no intermediary.
          </p>

          <div className="recipient-preview">
            <span className="recipient-label">Sending to</span>
            <span className="recipient-addr">{info!.recipient}</span>
          </div>

          <div className="field-group">
            <label>Amount (SOL)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <button
            className="btn-primary"
            onClick={handleDeposit}
            disabled={loading || !publicKey}
          >
            {loading
              ? "Sending…"
              : `Approve & Send${amountInput ? ` ${parseFloat(amountInput) || 0} SOL` : ""}`}
          </button>

          {!publicKey && (
            <p className="warn">Connect your wallet above to pay.</p>
          )}
        </div>
      )}

      {/* Completion states */}
      {isReleased && (
        <div className="success-notice">
          ✓ Payment of <strong>{info!.amountSol.toFixed(4)} SOL</strong> was sent
          directly to the recipient.
        </div>
      )}

      {isCancelled && (
        <div className="refund-notice">This escrow was cancelled by the admin.</div>
      )}

      {statusMsg && <p className="status-msg">{statusMsg}</p>}
    </div>
  );
};
