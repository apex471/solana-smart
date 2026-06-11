#!/usr/bin/env bash
# Usage: ./scripts/deploy.sh [devnet|mainnet-beta]
set -euo pipefail

CLUSTER=${1:-devnet}
PROGRAM_KEYPAIR="./program-keypair.json"

echo "==> Building program for $CLUSTER..."
cd "$(dirname "$0")/.."
cargo build-sbf --manifest-path program/Cargo.toml

BINARY="program/target/deploy/solana_escrow.so"

if [ ! -f "$PROGRAM_KEYPAIR" ]; then
  echo "==> Generating new program keypair at $PROGRAM_KEYPAIR"
  solana-keygen new --no-bip39-passphrase -o "$PROGRAM_KEYPAIR"
fi

PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
echo "==> Program ID: $PROGRAM_ID"

echo "==> Deploying to $CLUSTER..."
solana program deploy "$BINARY" \
  --keypair ~/.config/solana/id.json \
  --program-id "$PROGRAM_KEYPAIR" \
  --url "$CLUSTER"

echo ""
echo "Deployment complete!"
echo "Program ID: $PROGRAM_ID"
echo ""
echo "Set in your frontend:"
echo "  REACT_APP_PROGRAM_ID=$PROGRAM_ID"
