# emblem-bet

Provably fair dice gambling on Solana using $EMBLEM token.

[![Build & Test](https://github.com/jakegallen/emblem-bet/actions/workflows/test.yml/badge.svg)](https://github.com/jakegallen/emblem-bet/actions)

## Overview

On-chain Anchor program that powers [emblem.bet](https://emblem.bet). Players deposit $EMBLEM tokens into a program-controlled escrow, place provably fair bets, and receive instant on-chain settlement.

## Architecture

```
programs/emblem-bet/src/lib.rs    Core Anchor program (Rust)
sdk/src/index.ts                   TypeScript SDK for backend integration
tests/emblem-bet.ts               Full test suite (11 tests)
.devcontainer/                     GitHub Codespaces dev environment
.github/workflows/test.yml         CI: build, test, deploy to devnet
```

## How to Open in Codespaces (No Installation Required)

1. Click the green **Code** button on this repo
2. Select **Codespaces** tab
3. Click **Create codespace on main**
4. Wait ~3 minutes for the environment to build
5. You're in — the Anchor toolchain is pre-installed

Then run:
```bash
# Fund your devnet wallet (printed during setup)
# Go to https://faucet.solana.com and paste your address

# Build the program
anchor build

# Run all tests
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

## Program Instructions

| Instruction | Signer | Description |
|---|---|---|
| `initialize` | admin | One-time setup, creates house vault |
| `deposit` | player | Deposit EMBLEM into player vault PDA |
| `withdraw` | player | Withdraw EMBLEM from player vault |
| `request_bet` | player | Submit bet with committed server seed hash |
| `settle_bet` | server | Reveal seed, compute roll, settle tokens |
| `fund_house` | admin | Add to house bankroll |
| `drain_house` | admin | Remove from house bankroll |
| `set_paused` | admin | Emergency pause |
| `set_house_edge` | admin | Update house edge (50–1000 bps) |
| `transfer_admin` | admin | Transfer to multisig |

## PDAs

| Account | Seeds | Description |
|---|---|---|
| `GameConfig` | `["game_config"]` | Global config, house edge, stats |
| `HouseVault` | `["house_vault"]` | House bankroll token account |
| `PlayerState` | `["player_state", player]` | Player balance, nonce, stats |
| `PlayerVault` | `["player_vault", player]` | Player's escrow token account |
| `BetRequest` | `["bet_request", player]` | Active bet (one per player at a time) |

## Provably Fair Algorithm

```
# Before any bet — server commits:
server_seed     = random 32 bytes
server_seed_hash = SHA-256(server_seed)  ← stored on-chain

# Player submits request_bet with:
client_seed     = random 32 bytes (player's browser)

# Program derives roll (verified on-chain during settle_bet):
nonce    = player_state.nonce  (auto-incremented)
message  = hex(client_seed) + ":" + str(nonce)
hmac     = HMAC-SHA256(key=server_seed, data=message)
roll     = first_8_bytes_u64(hmac) mod 10000  → [0, 9999]

# Anyone can verify: given revealed server_seed, recompute roll
```

## Token

- Mint: `GEYrkRTuicSN7JHHQLGErWVsHKwHaAmzfFhLsNpBpump`
- Decimals: 9
- Minimum bet: 1 EMBLEM
- Default house edge: 2% (200 bps)
- Max single win: 50,000 EMBLEM

## Deployment Checklist

- [ ] Tests passing on devnet
- [ ] External audit (OtterSec / Sec3 recommended)
- [ ] Admin key moved to Squads multisig
- [ ] `DEPLOY_WALLET_KEYPAIR` secret added to GitHub repo
- [ ] Emergency pause tested
- [ ] House vault funded

## GitHub Actions: Auto Deploy

Push to `main` → CI builds and tests automatically.

To enable auto-deploy to devnet:
1. Go to repo **Settings** → **Secrets and variables** → **Actions**
2. Add secret: `DEPLOY_WALLET_KEYPAIR` = contents of your `~/.config/solana/id.json`
3. Create environment named `devnet` under **Settings** → **Environments**

## License

MIT
