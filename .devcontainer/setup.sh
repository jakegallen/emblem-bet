#!/bin/bash
set -e

echo "=== emblem-bet Devcontainer Setup ==="

# Install Yarn
npm install -g yarn

# Install Node dependencies for tests and SDK
cd /workspaces/emblem-bet
yarn install 2>/dev/null || true

cd sdk && yarn install && cd ..

# Generate a devnet keypair if one doesn't exist
if [ ! -f ~/.config/solana/id.json ]; then
  mkdir -p ~/.config/solana
  solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json
  echo ""
  echo "=== New devnet wallet generated ==="
  solana address
  echo "Fund it at: https://faucet.solana.com"
  echo ""
fi

# Set Solana config to devnet
solana config set --url devnet

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Your devnet wallet: $(solana address)"
echo ""
echo "Next steps:"
echo "  1. Fund your wallet: https://faucet.solana.com"
echo "  2. Build the program: anchor build"
echo "  3. Run tests: anchor test"
echo "  4. Deploy: anchor deploy --provider.cluster devnet"
echo ""
echo "After deploying, copy the Program ID and update:"
echo "  - declare_id!() in programs/emblem-bet/src/lib.rs"
echo "  - Anchor.toml [programs.devnet]"
