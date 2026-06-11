import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { EscrowPanel } from "./components/EscrowPanel";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./App.css";

const NETWORK    = WalletAdapterNetwork.Mainnet;
const PROGRAM_ID = new PublicKey(
  process.env.REACT_APP_PROGRAM_ID ?? "Escrow11111111111111111111111111111111111111"
);

// Use a reliable mainnet RPC — public Solana endpoint or env override
const RPC_ENDPOINT =
  process.env.REACT_APP_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export default function App() {
  const endpoint = useMemo(() => RPC_ENDPOINT, []);
  const wallets  = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <EscrowPanel programId={PROGRAM_ID} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
