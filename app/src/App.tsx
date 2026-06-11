import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  BackpackWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl, Keypair, PublicKey } from "@solana/web3.js";
import { WalletButton } from "./components/WalletButton";
import { EscrowPanel } from "./components/EscrowPanel";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./App.css";

// ---------------------------------------------------------------------------
// Config — replace with your deployed program ID on mainnet/devnet
// ---------------------------------------------------------------------------
const NETWORK = WalletAdapterNetwork.Devnet;
const PROGRAM_ID = new PublicKey(
  process.env.REACT_APP_PROGRAM_ID ?? "EscroW1111111111111111111111111111111111111111"
);

// In production the admin keypair lives server-side (never in the browser).
// This is a placeholder for demo purposes only.
const DEMO_ADMIN = Keypair.generate();

export default function App() {
  const endpoint = useMemo(() => clusterApiUrl(NETWORK), []);

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="app">
            <header className="app-header">
              <div className="header-left">
                <h1>Solana Escrow</h1>
                <span className="network-badge">{NETWORK}</span>
              </div>
              <WalletButton />
            </header>

            <main className="app-main">
              <EscrowPanel programId={PROGRAM_ID} adminKeypair={DEMO_ADMIN} />
            </main>

            <footer className="app-footer">
              <p>
                Funds are locked in a program-derived vault and released only
                by the admin when work is complete.
              </p>
            </footer>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
