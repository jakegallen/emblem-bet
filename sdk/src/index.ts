/**
 * emblem.bet SDK
 *
 * TypeScript client for the emblem-bet Anchor program.
 * Used by the emblem.bet backend server to interact with the Solana program.
 *
 * Usage:
 *   const client = new EmblemBetClient({ connection, wallet, programId, emblemMint });
 *   await client.initialize(200); // 2% house edge
 *   await client.deposit(playerWallet, 10_000_000_000n); // 10 EMBLEM
 *   const betId = await client.requestBet(...);
 *   const result = await client.settleBet(betId, serverSeed);
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN, web3 } from '@coral-xyz/anchor';
import * as crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BetDirection = 'under' | 'over';

export interface BetResult {
  roll: number;        // 0-9999
  rollDisplay: number; // 0.00-99.99 (roll / 100)
  won: boolean;
  payout: bigint;
  profit: bigint;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  txSignature: string;
}

export interface PlayerInfo {
  wallet: PublicKey;
  balance: bigint;
  totalWagered: bigint;
  totalWon: bigint;
  nonce: number;
}

export interface GameInfo {
  admin: PublicKey;
  emblemMint: PublicKey;
  houseEdgeBps: number;
  paused: boolean;
  totalWagered: bigint;
  totalPaidOut: bigint;
  totalBets: bigint;
  houseBalance: bigint;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const GAME_CONFIG_SEED = Buffer.from('game_config');
export const HOUSE_VAULT_SEED = Buffer.from('house_vault');
export const PLAYER_STATE_SEED = Buffer.from('player_state');
export const PLAYER_VAULT_SEED = Buffer.from('player_vault');
export const BET_REQUEST_SEED = Buffer.from('bet_request');

export const EMBLEM_MINT_MAINNET = new PublicKey(
  'GEYrkRTuicSN7JHHQLGErWVsHKwHaAmzfFhLsNpBpump'
);
export const EMBLEM_DECIMALS = 9;

// ─── PDA Derivation ───────────────────────────────────────────────────────────

export function deriveGameConfig(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GAME_CONFIG_SEED], programId);
}

export function deriveHouseVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([HOUSE_VAULT_SEED], programId);
}

export function derivePlayerState(
  player: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PLAYER_STATE_SEED, player.toBuffer()],
    programId
  );
}

export function derivePlayerVault(
  player: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PLAYER_VAULT_SEED, player.toBuffer()],
    programId
  );
}

export function deriveBetRequest(
  player: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BET_REQUEST_SEED, player.toBuffer()],
    programId
  );
}

// ─── Provably Fair Helpers ────────────────────────────────────────────────────

/**
 * Generate a cryptographically random server seed (32 bytes, hex-encoded).
 */
export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash the server seed with SHA-256.
 * This is committed on-chain before any bet is placed.
 */
export function hashServerSeed(seed: string): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest();
}

/**
 * Compute the roll result from server_seed + client_seed + nonce.
 * Matches the on-chain computation in lib.rs exactly.
 *
 * Result: integer in [0, 9999]
 * Display: result / 100 → [0.00, 99.99]
 */
export function computeRoll(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): number {
  const message = `${clientSeed}:${nonce}`;
  const hmac = crypto
    .createHmac('sha256', Buffer.from(serverSeed, 'hex'))
    .update(message)
    .digest();
  // Take first 8 bytes as big-endian u64
  const bigInt = hmac.readBigUInt64BE(0);
  return Number(bigInt % 10000n);
}

/**
 * Determine if a roll wins given the parameters.
 */
export function didWin(
  roll: number,
  winChanceBps: number,
  direction: BetDirection
): boolean {
  if (direction === 'under') {
    return roll < winChanceBps;
  } else {
    return roll >= 10000 - winChanceBps;
  }
}

/**
 * Calculate payout for a winning bet.
 * payout = amount * (10000 - house_edge_bps) / win_chance_bps
 */
export function calcPayout(
  amount: bigint,
  winChanceBps: number,
  houseEdgeBps: number
): bigint {
  return (amount * BigInt(10000 - houseEdgeBps)) / BigInt(winChanceBps);
}

/**
 * Convert EMBLEM amount (with 9 decimals) to human-readable.
 */
export function toEmblem(raw: bigint): number {
  return Number(raw) / 1e9;
}

/**
 * Convert human-readable EMBLEM to raw token amount.
 */
export function fromEmblem(amount: number): bigint {
  return BigInt(Math.round(amount * 1e9));
}

// ─── Main Client Class ────────────────────────────────────────────────────────

export interface EmblemBetClientConfig {
  connection: Connection;
  /** The admin/server keypair — used to sign settle_bet instructions */
  serverKeypair: Keypair;
  programId: PublicKey;
  emblemMint: PublicKey;
}

export class EmblemBetClient {
  connection: Connection;
  serverKeypair: Keypair;
  programId: PublicKey;
  emblemMint: PublicKey;
  program: Program<any>;

  // Derived PDAs (computed once)
  gameConfigPda: PublicKey;
  houseVaultPda: PublicKey;

  constructor(config: EmblemBetClientConfig) {
    this.connection = config.connection;
    this.serverKeypair = config.serverKeypair;
    this.programId = config.programId;
    this.emblemMint = config.emblemMint;

    // Set up Anchor provider with server keypair
    const wallet = new anchor.Wallet(this.serverKeypair);
    const provider = new AnchorProvider(
      this.connection,
      wallet,
      { commitment: 'confirmed', preflightCommitment: 'confirmed' }
    );

    // Load IDL (generated by `anchor build`)
    // In production: import idl from './idl/emblem_bet.json'
    this.program = new Program(IDL as any, this.programId, provider);

    [this.gameConfigPda] = deriveGameConfig(this.programId);
    [this.houseVaultPda] = deriveHouseVault(this.programId);
  }

  // ── Admin: Initialize ───────────────────────────────────────────────────────

  async initialize(houseEdgeBps: number): Promise<string> {
    const tx = await this.program.methods
      .initialize(houseEdgeBps)
      .accounts({
        admin: this.serverKeypair.publicKey,
        emblemMint: this.emblemMint,
        gameConfig: this.gameConfigPda,
        houseVault: this.houseVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return tx;
  }

  // ── Admin: Fund House ────────────────────────────────────────────────────────

  async fundHouse(amount: bigint): Promise<string> {
    const adminTokenAccount = await getAssociatedTokenAddress(
      this.emblemMint,
      this.serverKeypair.publicKey
    );
    const tx = await this.program.methods
      .fundHouse(new BN(amount.toString()))
      .accounts({
        admin: this.serverKeypair.publicKey,
        gameConfig: this.gameConfigPda,
        houseVault: this.houseVaultPda,
        adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    return tx;
  }

  // ── Admin: Pause ─────────────────────────────────────────────────────────────

  async setPaused(paused: boolean): Promise<string> {
    const tx = await this.program.methods
      .setPaused(paused)
      .accounts({
        admin: this.serverKeypair.publicKey,
        gameConfig: this.gameConfigPda,
      })
      .rpc();
    return tx;
  }

  // ── Game Info ────────────────────────────────────────────────────────────────

  async getGameInfo(): Promise<GameInfo> {
    const config = await this.program.account.gameConfig.fetch(this.gameConfigPda);
    const houseVault = await this.connection.getTokenAccountBalance(this.houseVaultPda);

    return {
      admin: config.admin,
      emblemMint: config.emblemMint,
      houseEdgeBps: config.houseEdgeBps,
      paused: config.paused,
      totalWagered: BigInt(config.totalWagered.toString()),
      totalPaidOut: BigInt(config.totalPaidOut.toString()),
      totalBets: BigInt(config.totalBets.toString()),
      houseBalance: BigInt(houseVault.value.amount),
    };
  }

  // ── Player Info ──────────────────────────────────────────────────────────────

  async getPlayerInfo(playerWallet: PublicKey): Promise<PlayerInfo | null> {
    const [playerStatePda] = derivePlayerState(playerWallet, this.programId);
    try {
      const state = await this.program.account.playerState.fetch(playerStatePda);
      return {
        wallet: state.wallet,
        balance: BigInt(state.balance.toString()),
        totalWagered: BigInt(state.totalWagered.toString()),
        totalWon: BigInt(state.totalWon.toString()),
        nonce: state.nonce.toNumber(),
      };
    } catch {
      return null; // Account doesn't exist yet
    }
  }

  // ── Settle Bet (called by server after request_bet) ──────────────────────────

  /**
   * Settle a pending bet by revealing the server seed.
   *
   * The server:
   * 1. Looks up the bet_request on-chain to get client_seed + nonce
   * 2. Reveals server_seed (which was committed as SHA-256(server_seed))
   * 3. The program verifies the hash, computes the roll, settles tokens
   *
   * Returns the full bet result including roll, won/lost, payout.
   */
  async settleBet(
    playerWallet: PublicKey,
    serverSeed: string
  ): Promise<BetResult> {
    const [playerStatePda] = derivePlayerState(playerWallet, this.programId);
    const [playerVaultPda] = derivePlayerVault(playerWallet, this.programId);
    const [betRequestPda] = deriveBetRequest(playerWallet, this.programId);

    // Fetch the bet to compute expected result locally (for response)
    const bet = await this.program.account.betRequest.fetch(betRequestPda);
    const clientSeed = Buffer.from(bet.clientSeed).toString('hex');
    const nonce = bet.nonce.toNumber();
    const winChanceBps = bet.winChanceBps;

    // Compute roll locally (matches on-chain computation)
    const roll = computeRoll(serverSeed, clientSeed, nonce);
    const direction: BetDirection = bet.direction.under ? 'under' : 'over';
    const won = didWin(roll, winChanceBps, direction);

    // Get house edge from config
    const config = await this.program.account.gameConfig.fetch(this.gameConfigPda);
    const houseEdgeBps = config.houseEdgeBps;

    const amount = BigInt(bet.amount.toString());
    const payout = won ? calcPayout(amount, winChanceBps, houseEdgeBps) : 0n;
    const profit = payout > 0n ? payout - amount : -amount;

    // Convert server_seed hex to bytes for the program
    const serverSeedBytes = Array.from(Buffer.from(serverSeed, 'hex'));

    const txSig = await this.program.methods
      .settleBet(serverSeedBytes)
      .accounts({
        server: this.serverKeypair.publicKey,
        player: playerWallet,
        gameConfig: this.gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        houseVault: this.houseVaultPda,
        betRequest: betRequestPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return {
      roll,
      rollDisplay: roll / 100,
      won,
      payout,
      profit,
      serverSeed,
      clientSeed,
      nonce,
      txSignature: txSig,
    };
  }

  // ── Build deposit instruction (signed by player, not server) ─────────────────

  /**
   * Build an unsigned deposit transaction for the player to sign.
   * The frontend sends this to the player's wallet for signing.
   */
  async buildDepositTx(
    playerWallet: PublicKey,
    amount: bigint
  ): Promise<Transaction> {
    const [playerStatePda] = derivePlayerState(playerWallet, this.programId);
    const [playerVaultPda] = derivePlayerVault(playerWallet, this.programId);

    const playerTokenAccount = await getAssociatedTokenAddress(
      this.emblemMint,
      playerWallet
    );

    const tx = await this.program.methods
      .deposit(new BN(amount.toString()))
      .accounts({
        player: playerWallet,
        gameConfig: this.gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        playerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .transaction();

    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;
    tx.feePayer = playerWallet;

    return tx;
  }

  /**
   * Build an unsigned withdraw transaction for the player to sign.
   */
  async buildWithdrawTx(
    playerWallet: PublicKey,
    amount: bigint
  ): Promise<Transaction> {
    const [playerStatePda] = derivePlayerState(playerWallet, this.programId);
    const [playerVaultPda] = derivePlayerVault(playerWallet, this.programId);

    const playerTokenAccount = await getAssociatedTokenAddress(
      this.emblemMint,
      playerWallet
    );

    const tx = await this.program.methods
      .withdraw(new BN(amount.toString()))
      .accounts({
        player: playerWallet,
        gameConfig: this.gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        playerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;
    tx.feePayer = playerWallet;

    return tx;
  }

  /**
   * Build an unsigned request_bet transaction for the player to sign.
   *
   * The server_seed_hash must be pre-committed — generate it on the server
   * BEFORE building this transaction and store the server_seed securely.
   */
  async buildRequestBetTx(
    playerWallet: PublicKey,
    amount: bigint,
    winChanceBps: number,
    direction: BetDirection,
    clientSeed: Uint8Array,   // 32 bytes from player's browser
    serverSeedHash: Uint8Array // 32 bytes: SHA-256(server_seed)
  ): Promise<Transaction> {
    const [playerStatePda] = derivePlayerState(playerWallet, this.programId);
    const [betRequestPda] = deriveBetRequest(playerWallet, this.programId);

    const directionArg = direction === 'under'
      ? { under: {} }
      : { over: {} };

    const tx = await this.program.methods
      .requestBet(
        new BN(amount.toString()),
        winChanceBps,
        directionArg,
        Array.from(clientSeed),
        Array.from(serverSeedHash)
      )
      .accounts({
        player: playerWallet,
        gameConfig: this.gameConfigPda,
        playerState: playerStatePda,
        houseVault: this.houseVaultPda,
        betRequest: betRequestPda,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .transaction();

    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;
    tx.feePayer = playerWallet;

    return tx;
  }
}

// ─── Placeholder IDL ──────────────────────────────────────────────────────────
// Replace with actual generated IDL from `anchor build`
const IDL = {
  version: '0.1.0',
  name: 'emblem_bet',
  instructions: [],
  accounts: [],
  errors: [],
};
