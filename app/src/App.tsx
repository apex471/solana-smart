import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
  Coin98WalletAdapter,
  CoinbaseWalletAdapter,
  BitgetWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { PublicKey } from "@solana/web3.js";
import { EscrowPanel } from "./components/EscrowPanel";
import { PRIMARY_RPC } from "./rpc";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./App.css";

const PROGRAM_ID = new PublicKey(
  process.env.REACT_APP_PROGRAM_ID ?? "Escrow11111111111111111111111111111111111111"
);

export default function App() {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new TrustWalletAdapter(),
    new Coin98WalletAdapter(),
    new CoinbaseWalletAdapter(),
    new BitgetWalletAdapter(),
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
