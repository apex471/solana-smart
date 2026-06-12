// Ordered list of free public mainnet RPCs.
// withFallbackRpc() tries each in sequence, skipping 403/429/auth failures.
// Set REACT_APP_RPC_URL on Render to prepend a private endpoint at position 0.
export const RPC_ENDPOINTS: string[] = (
  [
    process.env.REACT_APP_RPC_URL,
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
    "https://rpc.extrnode.com",
  ] as (string | undefined)[]
).filter((u): u is string => Boolean(u));

export const PRIMARY_RPC = RPC_ENDPOINTS[0];
