// Ordered list of free public mainnet RPCs — used only as last-resort fallback.
// Set REACT_APP_RPC_URL on Render to inject a private endpoint at position 0.
export const RPC_ENDPOINTS: string[] = (
  [
    process.env.REACT_APP_RPC_URL,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://rpc.ankr.com/solana",
    "https://solana.drpc.org",
    "https://solana-api.projectserum.com",
    "https://rpc.extrnode.com",
  ] as (string | undefined)[]
).filter((u): u is string => Boolean(u));

export const PRIMARY_RPC = RPC_ENDPOINTS[0];
