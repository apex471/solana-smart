import React, { useCallback, useEffect, useRef, useState } from "react";
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
// Inline Borsh helpers (browser-safe, no Node deps)
// ---------------------------------------------------------------------------
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
function bool(v: boolean): number[] { return [v ? 1 : 0]; }

function padId(id: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(id.slice(0, 32)).copy(b);
  return b;
}
function pda(programId: PublicKey, prefix: string, id: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(prefix), padId(id)],
    programId
  )[0];
}

// Instruction encoders
const enc = {
  deposit: (id: string, lamports: bigint) =>
    Buffer.from([...u8(1), ...str(id), ...u64le(lamports)]),
  claim: (id: string) =>
    Buffer.from([...u8(2), ...str(id)]),
  dispute: (id: string) =>
    Buffer.from([...u8(3), ...str(id)]),
  resolve: (id: string, release: boolean) =>
    Buffer.from([...u8(4), ...str(id), ...bool(release)]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Disputed",
  3: "Released",
  4: "Refunded",
};

interface EscrowInfo {
  admin: string;
  depositor: string;
  recipient: string;
  amountSol: number;
  status: number;
  createdAt: number;
  releaseAfter: number;   // unix timestamp
  disputeWindow: number;  // seconds
}

// ---------------------------------------------------------------------------
// Countdown hook
// ---------------------------------------------------------------------------
function useCountdown(targetUnix: number) {
  const [remaining, setRemaining] = useState(targetUnix - Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(targetUnix - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [targetUnix]);
  return remaining;
}

function formatDuration(secs: number): string {
  if (secs <= 0) return "Elapsed";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  programId: PublicKey;
  adminKeypair: Keypair;
}

export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [escrowId,    setEscrowId]    = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [escrowInfo,  setEscrowInfo]  = useState<EscrowInfo | null>(null);
  const [vaultBal,    setVaultBal]    = useState<number | null>(null);
  const [statusMsg,   setStatusMsg]   = useState("");
  const [loading,     setLoading]     = useState<string | null>(null);

  const log = (msg: string) => setStatusMsg(msg);

  // ---- fetch state --------------------------------------------------------
  const refreshEscrow = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const statePDA = pda(programId, "escrow", id);
        const vaultPDA = pda(programId, "vault",  id);
        const [stateInfo, vaultLamports] = await Promise.all([
          connection.getAccountInfo(statePDA),
          connection.getBalance(vaultPDA),
        ]);
        if (!stateInfo) { setEscrowInfo(null); setVaultBal(null); return; }

        const d = Buffer.from(stateInfo.data);
        let off = 1;
        const readPK = () => {
          const pk = new PublicKey(d.slice(off, off + 32)).toBase58();
          off += 32;
          return pk;
        };
        const readI64 = () => {
          let v = 0n;
          for (let i = 0; i < 8; i++) v |= BigInt(d[off + i]) << BigInt(i * 8);
          off += 8;
          return v >= 0x8000000000000000n ? Number(v - 0x10000000000000000n) : Number(v);
        };

        const admin      = readPK();
        const depositor  = readPK();
        const recipient  = readPK();
        const amount     = readI64(); // u64 fits in i64 for our purposes
        const status     = d[off++];
        off += 32; // escrow_id bytes
        const createdAt     = readI64();
        const releaseAfter  = readI64();
        const disputeWindow = readI64();

        setEscrowInfo({
          admin, depositor, recipient,
          amountSol: amount / LAMPORTS_PER_SOL,
          status,
          createdAt,
          releaseAfter,
          disputeWindow,
        });
        setVaultBal(vaultLamports / LAMPORTS_PER_SOL);
      } catch { setEscrowInfo(null); }
    },
    [connection, programId]
  );

  useEffect(() => { if (escrowId) refreshEscrow(escrowId); }, [escrowId, refreshEscrow]);

  // ---- countdown ----------------------------------------------------------
  const countdown = useCountdown(escrowInfo?.releaseAfter ?? 0);
  const disputeDeadlineUnix = escrowInfo
    ? escrowInfo.createdAt + escrowInfo.disputeWindow
    : 0;
  const disputeCountdown = useCountdown(disputeDeadlineUnix);

  // ---- send helpers -------------------------------------------------------
  const send = async (label: string, buildTx: () => Transaction) => {
    if (!publicKey) return log("Connect your wallet first.");
    setLoading(label);
    try {
      const tx  = buildTx();
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      log(`${label} confirmed! Tx: ${sig.slice(0, 20)}…`);
      await refreshEscrow(escrowId);
    } catch (e: any) {
      log(`${label} failed: ${e?.message ?? e}`);
    } finally {
      setLoading(null);
    }
  };

  const handleDeposit = () => {
    const amount = parseFloat(amountInput);
    if (!escrowId || isNaN(amount) || amount <= 0)
      return log("Enter a valid escrow ID and SOL amount.");
    send("Deposit", () => {
      const vaultPDA = pda(programId, "vault",  escrowId);
      const statePDA = pda(programId, "escrow", escrowId);
      const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey!, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,   isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,   isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: enc.deposit(escrowId, lamports),
      });
      return new Transaction().add(ix);
    });
  };

  const handleClaim = () =>
    send("Claim", () => {
      const statePDA = pda(programId, "escrow", escrowId);
      const vaultPDA = pda(programId, "vault",  escrowId);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey!, isSigner: true,  isWritable: true  },
          { pubkey: statePDA,   isSigner: false, isWritable: true  },
          { pubkey: vaultPDA,   isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: enc.claim(escrowId),
      });
      return new Transaction().add(ix);
    });

  const handleDispute = () =>
    send("Dispute", () => {
      const statePDA = pda(programId, "escrow", escrowId);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey!, isSigner: true,  isWritable: false },
          { pubkey: statePDA,   isSigner: false, isWritable: true  },
        ],
        data: enc.dispute(escrowId),
      });
      return new Transaction().add(ix);
    });

  // ---- derived booleans ---------------------------------------------------
  const now          = Math.floor(Date.now() / 1000);
  const canClaim     = escrowInfo?.status === 1 && now >= (escrowInfo?.releaseAfter ?? Infinity);
  const canDispute   = escrowInfo?.status === 1 && now <= disputeDeadlineUnix;
  const isRecipient  = escrowInfo && publicKey?.toBase58() === escrowInfo.recipient;
  const isDepositor  = escrowInfo && publicKey?.toBase58() === escrowInfo.depositor;

  // ---- render -------------------------------------------------------------
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

      {/* ---- Status card -------------------------------------------------- */}
      {escrowInfo ? (
        <div className="escrow-info">
          <div className={`status-badge status-${escrowInfo.status}`}>
            {STATUS_LABELS[escrowInfo.status] ?? "Unknown"}
          </div>

          <table><tbody>
            <tr><td>Admin</td>     <td className="mono">{escrowInfo.admin.slice(0,16)}…</td></tr>
            <tr><td>Depositor</td> <td className="mono">{escrowInfo.depositor === "11111111111111111111111111111111" ? "—" : escrowInfo.depositor.slice(0,16) + "…"}</td></tr>
            <tr><td>Recipient</td> <td className="mono">{escrowInfo.recipient.slice(0,16)}…</td></tr>
            <tr><td>Locked</td>    <td>{escrowInfo.amountSol.toFixed(4)} SOL</td></tr>
            <tr><td>Vault</td>     <td>{vaultBal?.toFixed(4) ?? "—"} SOL</td></tr>
          </tbody></table>

          {/* Active countdown */}
          {escrowInfo.status === 1 && (
            <div className="timers">
              <div className={`timer-block ${countdown <= 0 ? "timer-ready" : ""}`}>
                <span className="timer-label">Auto-release in</span>
                <span className="timer-value">
                  {countdown > 0 ? formatDuration(countdown) : "Ready to claim ✓"}
                </span>
              </div>
              {disputeCountdown > 0 && (
                <div className="timer-block timer-dispute">
                  <span className="timer-label">Dispute window closes in</span>
                  <span className="timer-value">{formatDuration(disputeCountdown)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      ) : escrowId ? (
        <p className="no-escrow">No escrow found for "{escrowId}"</p>
      ) : null}

      {/* ---- Deposit form ------------------------------------------------- */}
      {(!escrowInfo || escrowInfo.status === 0) && (
        <div className="action-section">
          <h3>Fund Escrow</h3>
          <p className="hint">
            Funds lock immediately on deposit. The recipient can claim them
            automatically after the lockup period — no admin approval needed.
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
            disabled={!!loading || !publicKey}
          >
            {loading === "Deposit" ? "Locking funds…" : "Deposit & Start Contract"}
          </button>
          {!publicKey && <p className="warn">Connect your wallet to deposit.</p>}
        </div>
      )}

      {/* ---- Recipient: claim --------------------------------------------- */}
      {escrowInfo?.status === 1 && isRecipient && (
        <div className="action-section">
          <h3>Claim Your Payment</h3>
          {canClaim ? (
            <>
              <p className="hint success-hint">
                The lockup has expired. You can now claim your funds directly — no admin needed.
              </p>
              <button
                className="btn-primary"
                onClick={handleClaim}
                disabled={!!loading}
              >
                {loading === "Claim" ? "Claiming…" : "Claim Funds Now"}
              </button>
            </>
          ) : (
            <p className="hint">
              Funds will be claimable in <strong>{formatDuration(countdown)}</strong>.
              The button will appear automatically.
            </p>
          )}
        </div>
      )}

      {/* ---- Depositor: raise dispute ------------------------------------- */}
      {escrowInfo?.status === 1 && isDepositor && canDispute && (
        <div className="action-section dispute-section">
          <h3>Raise a Dispute</h3>
          <p className="hint">
            If work was not delivered, raise a dispute before the window closes
            to freeze the funds for admin review.
            Window closes in <strong>{formatDuration(disputeCountdown)}</strong>.
          </p>
          <button
            className="btn-danger"
            onClick={handleDispute}
            disabled={!!loading}
          >
            {loading === "Dispute" ? "Raising dispute…" : "Raise Dispute"}
          </button>
        </div>
      )}

      {/* ---- Status notices ----------------------------------------------- */}
      {escrowInfo?.status === 2 && (
        <div className="active-notice disputed">
          ⚠ Funds are frozen — admin is reviewing this dispute.
        </div>
      )}
      {escrowInfo?.status === 3 && (
        <div className="success-notice">Payment released to recipient.</div>
      )}
      {escrowInfo?.status === 4 && (
        <div className="refund-notice">Funds refunded to depositor.</div>
      )}

      {statusMsg && <p className="status-msg">{statusMsg}</p>}
    </div>
  );
};
