import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { PublicKey } from "@solana/web3.js";
import { EscrowPanel } from "./components/EscrowPanel";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./App.css";

const PROGRAM_ID = new PublicKey(
  process.env.REACT_APP_PROGRAM_ID ?? "Escrow11111111111111111111111111111111111111"
);

// Ordered list of free public mainnet RPCs — first working one is used.
// Set REACT_APP_RPC_URL on Render to override with a private endpoint.
export const RPC_ENDPOINTS: string[] = [
  process.env.REACT_APP_RPC_URL,
  "https://api.mainnet-beta.solana.com",        // official Solana
  "https://solana-api.projectserum.com",         // Project Serum
  "https://rpc.extrnode.com",                   // ExtrNode
].filter(Boolean) as string[];

export const PRIMARY_RPC = RPC_ENDPOINTS[0];

export default function App() {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={PRIMARY_RPC} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <EscrowPanel programId={PROGRAM_ID} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
