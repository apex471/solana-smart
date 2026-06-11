import React, { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Borsh helpers (browser-safe)
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
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), padId(id)], programId)[0];
}

const enc = {
  deposit: (id: string, lp: bigint) => Buffer.from([...u8(1), ...str(id), ...u64le(lp)]),
  claim:   (id: string)             => Buffer.from([...u8(2), ...str(id)]),
  dispute: (id: string)             => Buffer.from([...u8(3), ...str(id)]),
  resolve: (id: string, r: boolean) => Buffer.from([...u8(4), ...str(id), ...bool(r)]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
const STATUS_LABELS: Record<number, string> = {
  0: "Pending", 1: "Active", 2: "Disputed", 3: "Released", 4: "Refunded",
};

interface EscrowInfo {
  admin: string; depositor: string; recipient: string;
  amountSol: number; status: number; createdAt: number;
}

interface Props { programId: PublicKey; adminKeypair: Keypair; }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [escrowId,    setEscrowId]    = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [info,        setInfo]        = useState<EscrowInfo | null>(null);
  const [vaultBal,    setVaultBal]    = useState<number | null>(null);
  const [statusMsg,   setStatusMsg]   = useState("");
  const [loading,     setLoading]     = useState<string | null>(null);

  // ---- fetch on-chain state -----------------------------------------------
  const refresh = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const statePDA = pda(programId, "escrow", id);
      const vaultPDA = pda(programId, "vault",  id);
      const [si, vb] = await Promise.all([
        connection.getAccountInfo(statePDA),
        connection.getBalance(vaultPDA),
      ]);
      if (!si) { setInfo(null); setVaultBal(null); return; }
      const d = Buffer.from(si.data);
      let o = 1;
      const rPK = () => {
        const pk = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32; return pk;
      };
      const rU64 = () => {
        let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(d[o + i]) << BigInt(i * 8);
        o += 8; return Number(v);
      };
      const admin    = rPK();
      const depositor = rPK();
      const recipient = rPK();
      const amount   = rU64();
      const status   = d[o++];
      o += 32; // escrow_id bytes
      const createdAt = rU64();
      setInfo({ admin, depositor, recipient, amountSol: amount / LAMPORTS_PER_SOL, status, createdAt });
      setVaultBal(vb / LAMPORTS_PER_SOL);
    } catch { setInfo(null); }
  }, [connection, programId]);

  useEffect(() => { if (escrowId) refresh(escrowId); }, [escrowId, refresh]);

  // ---- send helper --------------------------------------------------------
  const send = async (label: string, buildTx: () => Transaction) => {
    if (!publicKey) return setStatusMsg("Connect your wallet first.");
    setLoading(label);
    try {
      const sig = await sendTransaction(buildTx(), connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatusMsg(`${label} confirmed! Tx: ${sig.slice(0, 20)}…`);
      await refresh(escrowId);
    } catch (e: any) {
      setStatusMsg(`${label} failed: ${e?.message ?? e}`);
    } finally { setLoading(null); }
  };

  // ---- handlers -----------------------------------------------------------
  const handleDeposit = () => {
    const amount = parseFloat(amountInput);
    if (!escrowId || isNaN(amount) || amount <= 0)
      return setStatusMsg("Enter an escrow ID and amount.");
    send("Deposit", () => {
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey!, isSigner: true, isWritable: true },
          { pubkey: pda(programId, "escrow", escrowId), isSigner: false, isWritable: true },
          { pubkey: pda(programId, "vault",  escrowId), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: enc.deposit(escrowId, BigInt(Math.floor(amount * LAMPORTS_PER_SOL))),
      });
      return new Transaction().add(ix);
    });
  };

  const handleClaim = () =>
    send("Claim", () => new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: publicKey!, isSigner: true, isWritable: true },
        { pubkey: pda(programId, "escrow", escrowId), isSigner: false, isWritable: true },
        { pubkey: pda(programId, "vault",  escrowId), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: enc.claim(escrowId),
    })));

  const handleDispute = () =>
    send("Dispute", () => new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: publicKey!, isSigner: true, isWritable: false },
        { pubkey: pda(programId, "escrow", escrowId), isSigner: false, isWritable: true },
      ],
      data: enc.dispute(escrowId),
    })));

  // ---- derived booleans ---------------------------------------------------
  const isRecipient = info && publicKey?.toBase58() === info.recipient;
  const isDepositor = info && publicKey?.toBase58() === info.depositor;

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
      {info ? (
        <div className="escrow-info">
          <div className={`status-badge status-${info.status}`}>
            {STATUS_LABELS[info.status]}
          </div>
          <table><tbody>
            <tr><td>Admin</td>     <td className="mono">{info.admin.slice(0, 16)}…</td></tr>
            <tr><td>Depositor</td> <td className="mono">
              {info.depositor === "11111111111111111111111111111111"
                ? "—" : info.depositor.slice(0, 16) + "…"}
            </td></tr>
            <tr><td>Recipient</td> <td className="mono">{info.recipient.slice(0, 16)}…</td></tr>
            <tr><td>Locked</td>    <td>{info.amountSol.toFixed(4)} SOL</td></tr>
            <tr><td>Vault</td>     <td>{vaultBal?.toFixed(4) ?? "—"} SOL</td></tr>
          </tbody></table>
        </div>
      ) : escrowId ? (
        <p className="no-escrow">No escrow found for "{escrowId}"</p>
      ) : null}

      {/* ---- Deposit form ------------------------------------------------- */}
      {(!info || info.status === 0) && (
        <div className="action-section">
          <h3>Fund Escrow</h3>
          <p className="hint">
            Funds lock instantly on deposit and are available for the recipient
            to claim immediately — no timer, no admin approval.
          </p>
          <div className="field-group">
            <label>Amount (SOL)</label>
            <input
              type="number" min="0" step="0.01"
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
            {loading === "Deposit" ? "Locking funds…" : "Deposit & Lock Funds"}
          </button>
          {!publicKey && <p className="warn">Connect your wallet to deposit.</p>}
        </div>
      )}

      {/* ---- Recipient: claim now ----------------------------------------- */}
      {info?.status === 1 && isRecipient && (
        <div className="action-section">
          <h3>Claim Your Payment</h3>
          <p className="hint success-hint">
            Funds are ready — claim them now directly to your wallet.
          </p>
          <button
            className="btn-primary"
            onClick={handleClaim}
            disabled={!!loading}
          >
            {loading === "Claim" ? "Claiming…" : "Claim Funds Now"}
          </button>
        </div>
      )}

      {/* ---- Depositor: raise dispute ------------------------------------- */}
      {info?.status === 1 && isDepositor && (
        <div className="action-section dispute-section">
          <h3>Raise a Dispute</h3>
          <p className="hint">
            If work was not delivered, raise a dispute to freeze the funds
            for admin review before the recipient claims.
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
      {info?.status === 2 && (
        <div className="active-notice disputed">
          ⚠ Funds are frozen — admin is reviewing this dispute.
        </div>
      )}
      {info?.status === 3 && (
        <div className="success-notice">Payment released to recipient.</div>
      )}
      {info?.status === 4 && (
        <div className="refund-notice">Funds refunded to depositor.</div>
      )}

      {statusMsg && <p className="status-msg">{statusMsg}</p>}
    </div>
  );
};
