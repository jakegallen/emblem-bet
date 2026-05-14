/**
 * emblem-bet Test Suite
 *
 * Tests all 7 instructions against localnet/devnet.
 * Run with: anchor test
 *
 * Prerequisites:
 *   - EMBLEM token mint deployed (or use test fixtures)
 *   - Admin wallet funded with SOL + EMBLEM
 *   - Player wallet funded with SOL + EMBLEM
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert } from 'chai';
import * as crypto from 'crypto';
import {
  deriveGameConfig,
  deriveHouseVault,
  derivePlayerState,
  derivePlayerVault,
  deriveBetRequest,
  generateServerSeed,
  hashServerSeed,
  computeRoll,
  calcPayout,
  fromEmblem,
  toEmblem,
} from '../sdk/src';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hexToBytes(hex: string): number[] {
  return Array.from(Buffer.from(hex, 'hex'));
}

function randomClientSeed(): number[] {
  return Array.from(crypto.randomBytes(32));
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('emblem-bet', () => {
  // Set up provider from Anchor.toml
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EmblemBet as Program<any>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const player = Keypair.generate();

  let emblemMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let playerTokenAccount: PublicKey;

  let gameConfigPda: PublicKey;
  let houseVaultPda: PublicKey;
  let playerStatePda: PublicKey;
  let playerVaultPda: PublicKey;
  let betRequestPda: PublicKey;

  // House edge: 2%
  const HOUSE_EDGE_BPS = 200;
  // Test amounts
  const HOUSE_SEED_AMOUNT = fromEmblem(100_000); // 100,000 EMBLEM bankroll
  const DEPOSIT_AMOUNT = fromEmblem(1_000);       // 1,000 EMBLEM

  before(async () => {
    console.log('\n── Setup ─────────────────────────────────────────────────');
    console.log(`Admin: ${admin.publicKey.toBase58()}`);
    console.log(`Player: ${player.publicKey.toBase58()}`);
    console.log(`Program: ${program.programId.toBase58()}`);

    // Derive PDAs
    [gameConfigPda] = deriveGameConfig(program.programId);
    [houseVaultPda] = deriveHouseVault(program.programId);
    [playerStatePda] = derivePlayerState(player.publicKey, program.programId);
    [playerVaultPda] = derivePlayerVault(player.publicKey, program.programId);
    [betRequestPda] = deriveBetRequest(player.publicKey, program.programId);

    // Airdrop SOL to player
    const sig = await provider.connection.requestAirdrop(
      player.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, 'confirmed');

    // Create EMBLEM test mint
    emblemMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,  // mint authority
      null,             // freeze authority
      9,                // 9 decimals (same as mainnet EMBLEM)
    );
    console.log(`EMBLEM Mint: ${emblemMint.toBase58()}`);

    // Create token accounts and mint test EMBLEM
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      emblemMint,
      admin.publicKey
    );
    playerTokenAccount = await createAccount(
      provider.connection,
      admin,          // payer
      emblemMint,
      player.publicKey
    );

    // Mint EMBLEM to admin (house bankroll) and player
    await mintTo(
      provider.connection,
      admin,
      emblemMint,
      adminTokenAccount,
      admin,
      Number(HOUSE_SEED_AMOUNT) + Number(fromEmblem(10_000))
    );
    await mintTo(
      provider.connection,
      admin,
      emblemMint,
      playerTokenAccount,
      admin,
      Number(DEPOSIT_AMOUNT)
    );

    console.log('Setup complete.\n');
  });

  // ── Test 1: Initialize ───────────────────────────────────────────────────────

  it('initializes the game config', async () => {
    const tx = await program.methods
      .initialize(HOUSE_EDGE_BPS)
      .accounts({
        admin: admin.publicKey,
        emblemMint,
        gameConfig: gameConfigPda,
        houseVault: houseVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log(`initialize tx: ${tx}`);

    const config = await program.account.gameConfig.fetch(gameConfigPda);
    assert.equal(config.admin.toBase58(), admin.publicKey.toBase58(), 'admin mismatch');
    assert.equal(config.houseEdgeBps, HOUSE_EDGE_BPS, 'house edge mismatch');
    assert.equal(config.paused, false, 'should not be paused');
    assert.equal(config.totalBets.toNumber(), 0, 'should have 0 bets');
    console.log('✓ initialize: config created with correct parameters');
  });

  it('rejects invalid house edge', async () => {
    try {
      await program.methods
        .initialize(5000) // 50% — over the max of 10%
        .accounts({
          admin: admin.publicKey,
          emblemMint,
          gameConfig: gameConfigPda,
          houseVault: houseVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      assert.fail('Should have thrown');
    } catch (e: any) {
      assert.include(e.message, 'InvalidHouseEdge');
      console.log('✓ initialize: rejects invalid house edge');
    }
  });

  // ── Test 2: Fund House ───────────────────────────────────────────────────────

  it('admin can fund the house vault', async () => {
    const tx = await program.methods
      .fundHouse(new BN(HOUSE_SEED_AMOUNT.toString()))
      .accounts({
        admin: admin.publicKey,
        gameConfig: gameConfigPda,
        houseVault: houseVaultPda,
        adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    console.log(`fundHouse tx: ${tx}`);

    const vault = await getAccount(provider.connection, houseVaultPda);
    assert.equal(
      vault.amount.toString(),
      HOUSE_SEED_AMOUNT.toString(),
      'house vault balance mismatch'
    );
    console.log(`✓ fund_house: ${toEmblem(HOUSE_SEED_AMOUNT)} EMBLEM in house vault`);
  });

  // ── Test 3: Deposit ──────────────────────────────────────────────────────────

  it('player can deposit EMBLEM', async () => {
    const tx = await program.methods
      .deposit(new BN(DEPOSIT_AMOUNT.toString()))
      .accounts({
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        playerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([player])
      .rpc();

    console.log(`deposit tx: ${tx}`);

    const state = await program.account.playerState.fetch(playerStatePda);
    assert.equal(
      state.balance.toString(),
      DEPOSIT_AMOUNT.toString(),
      'player balance mismatch'
    );

    // Verify player wallet was debited
    const walletAccount = await getAccount(provider.connection, playerTokenAccount);
    assert.equal(walletAccount.amount.toString(), '0', 'wallet should be empty after deposit');

    console.log(`✓ deposit: player has ${toEmblem(DEPOSIT_AMOUNT)} EMBLEM in vault`);
  });

  it('rejects deposit below minimum', async () => {
    const tinyAmount = 100n; // 0.0000001 EMBLEM — below 1 EMBLEM minimum
    try {
      await program.methods
        .deposit(new BN(tinyAmount.toString()))
        .accounts({
          player: player.publicKey,
          gameConfig: gameConfigPda,
          playerState: playerStatePda,
          playerVault: playerVaultPda,
          playerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([player])
        .rpc();
      assert.fail('Should have thrown');
    } catch (e: any) {
      assert.include(e.message, 'BetTooSmall');
      console.log('✓ deposit: rejects amounts below minimum');
    }
  });

  // ── Test 4: Place Bet (request_bet + settle_bet) ─────────────────────────────

  it('player can place and win a bet', async () => {
    // Generate server seed and commit its hash
    const serverSeed = generateServerSeed();
    const serverSeedHashBuf = hashServerSeed(serverSeed);
    const serverSeedHashArr = Array.from(serverSeedHashBuf);

    // Client seed (random 32 bytes from player)
    const clientSeedArr = randomClientSeed();

    // Bet: 10 EMBLEM at 90% win chance, roll under
    const betAmount = fromEmblem(10);
    const winChanceBps = 9000; // 90%
    const direction = { under: {} };

    // Get current player state for nonce
    const stateBefore = await program.account.playerState.fetch(playerStatePda);
    const nonce = stateBefore.nonce.toNumber() + 1;

    // Pre-compute what the roll will be (for assertion)
    const clientSeedHex = Buffer.from(clientSeedArr).toString('hex');
    const expectedRoll = computeRoll(serverSeed, clientSeedHex, nonce);
    const expectedWon = expectedRoll < winChanceBps; // Roll Under 90%
    console.log(`  Expected roll: ${expectedRoll} (${expectedRoll / 100}%) — ${expectedWon ? 'WIN' : 'LOSE'}`);

    // Step 1: request_bet (signed by player)
    const reqTx = await program.methods
      .requestBet(
        new BN(betAmount.toString()),
        winChanceBps,
        direction,
        clientSeedArr,
        serverSeedHashArr
      )
      .accounts({
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        houseVault: houseVaultPda,
        betRequest: betRequestPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([player])
      .rpc();

    console.log(`  request_bet tx: ${reqTx}`);

    // Verify bet is recorded
    const bet = await program.account.betRequest.fetch(betRequestPda);
    assert.equal(bet.amount.toString(), betAmount.toString(), 'bet amount mismatch');
    assert.equal(bet.winChanceBps, winChanceBps, 'win chance mismatch');

    // Verify player balance was debited
    const stateAfterReq = await program.account.playerState.fetch(playerStatePda);
    const expectedBalAfterReq = BigInt(stateBefore.balance.toString()) - betAmount;
    assert.equal(
      stateAfterReq.balance.toString(),
      expectedBalAfterReq.toString(),
      'balance not debited'
    );

    // Step 2: settle_bet (signed by server/admin)
    const serverSeedBytes = hexToBytes(serverSeed);
    const settleTx = await program.methods
      .settleBet(serverSeedBytes)
      .accounts({
        server: admin.publicKey,
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        houseVault: houseVaultPda,
        betRequest: betRequestPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    console.log(`  settle_bet tx: ${settleTx}`);

    // Verify player state updated correctly
    const stateAfterSettle = await program.account.playerState.fetch(playerStatePda);
    if (expectedWon) {
      const expectedPayout = calcPayout(betAmount, winChanceBps, HOUSE_EDGE_BPS);
      const expectedBalance = expectedBalAfterReq + expectedPayout;
      assert.equal(
        stateAfterSettle.balance.toString(),
        expectedBalance.toString(),
        'winning balance mismatch'
      );
      console.log(`✓ bet (WIN): rolled ${expectedRoll}, won ${toEmblem(expectedPayout)} EMBLEM`);
    } else {
      assert.equal(
        stateAfterSettle.balance.toString(),
        expectedBalAfterReq.toString(),
        'losing balance should remain'
      );
      console.log(`✓ bet (LOSE): rolled ${expectedRoll}, lost ${toEmblem(betAmount)} EMBLEM`);
    }

    // Verify bet_request account is closed
    try {
      await program.account.betRequest.fetch(betRequestPda);
      assert.fail('bet_request should be closed');
    } catch {
      console.log('✓ bet_request account closed after settlement');
    }
  });

  it('rejects invalid server seed on settle', async () => {
    // Place a bet first
    const serverSeed = generateServerSeed();
    const serverSeedHashArr = Array.from(hashServerSeed(serverSeed));
    const clientSeedArr = randomClientSeed();
    const betAmount = fromEmblem(5);

    await program.methods
      .requestBet(
        new BN(betAmount.toString()),
        5000, // 50%
        { under: {} },
        clientSeedArr,
        serverSeedHashArr
      )
      .accounts({
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        houseVault: houseVaultPda,
        betRequest: betRequestPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([player])
      .rpc();

    // Try to settle with a WRONG server seed
    const wrongSeed = generateServerSeed();
    const wrongSeedBytes = hexToBytes(wrongSeed);

    try {
      await program.methods
        .settleBet(wrongSeedBytes)
        .accounts({
          server: admin.publicKey,
          player: player.publicKey,
          gameConfig: gameConfigPda,
          playerState: playerStatePda,
          playerVault: playerVaultPda,
          houseVault: houseVaultPda,
          betRequest: betRequestPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      assert.fail('Should have rejected wrong server seed');
    } catch (e: any) {
      assert.include(e.message, 'InvalidServerSeed');
      console.log('✓ settle_bet: rejects wrong server seed (provably fair protection)');
    }

    // Clean up — settle with correct seed
    await program.methods
      .settleBet(hexToBytes(serverSeed))
      .accounts({
        server: admin.publicKey,
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        houseVault: houseVaultPda,
        betRequest: betRequestPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
  });

  it('enforces house insolvency protection', async () => {
    // Try to bet more than the house can pay
    const hugeWinChanceBps = 100; // 1% win chance = 98x payout
    const hugeAmount = fromEmblem(2_000); // Would require 196,000 EMBLEM payout

    try {
      await program.methods
        .requestBet(
          new BN(hugeAmount.toString()),
          hugeWinChanceBps,
          { under: {} },
          randomClientSeed(),
          Array.from(hashServerSeed(generateServerSeed()))
        )
        .accounts({
          player: player.publicKey,
          gameConfig: gameConfigPda,
          playerState: playerStatePda,
          houseVault: houseVaultPda,
          betRequest: betRequestPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([player])
        .rpc();
      assert.fail('Should have been blocked by insolvency check');
    } catch (e: any) {
      assert.include(e.message, 'HouseInsolvent');
      console.log('✓ request_bet: blocks bets that would exceed house vault');
    }
  });

  // ── Test 5: Withdraw ─────────────────────────────────────────────────────────

  it('player can withdraw EMBLEM', async () => {
    const stateBefore = await program.account.playerState.fetch(playerStatePda);
    const withdrawAmount = BigInt(stateBefore.balance.toString());

    const tx = await program.methods
      .withdraw(new BN(withdrawAmount.toString()))
      .accounts({
        player: player.publicKey,
        gameConfig: gameConfigPda,
        playerState: playerStatePda,
        playerVault: playerVaultPda,
        playerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([player])
      .rpc();

    console.log(`withdraw tx: ${tx}`);

    const stateAfter = await program.account.playerState.fetch(playerStatePda);
    assert.equal(stateAfter.balance.toString(), '0', 'balance should be 0 after full withdrawal');

    const walletAccount = await getAccount(provider.connection, playerTokenAccount);
    assert.equal(
      walletAccount.amount.toString(),
      withdrawAmount.toString(),
      'wallet should have withdrawn amount'
    );

    console.log(`✓ withdraw: ${toEmblem(withdrawAmount)} EMBLEM returned to player wallet`);
  });

  it('rejects withdrawal exceeding balance', async () => {
    try {
      await program.methods
        .withdraw(new BN(fromEmblem(999_999).toString()))
        .accounts({
          player: player.publicKey,
          gameConfig: gameConfigPda,
          playerState: playerStatePda,
          playerVault: playerVaultPda,
          playerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player])
        .rpc();
      assert.fail('Should have rejected');
    } catch (e: any) {
      assert.include(e.message, 'InsufficientBalance');
      console.log('✓ withdraw: rejects over-withdrawal');
    }
  });

  // ── Test 6: Admin Controls ───────────────────────────────────────────────────

  it('admin can pause and unpause the game', async () => {
    await program.methods
      .setPaused(true)
      .accounts({
        admin: admin.publicKey,
        gameConfig: gameConfigPda,
      })
      .signers([admin])
      .rpc();

    let config = await program.account.gameConfig.fetch(gameConfigPda);
    assert.equal(config.paused, true, 'should be paused');

    // Verify paused state blocks deposits
    try {
      await program.methods
        .deposit(new BN(fromEmblem(10).toString()))
        .accounts({
          player: player.publicKey,
          gameConfig: gameConfigPda,
          playerState: playerStatePda,
          playerVault: playerVaultPda,
          playerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([player])
        .rpc();
      assert.fail('Should be paused');
    } catch (e: any) {
      assert.include(e.message, 'GamePaused');
    }

    await program.methods
      .setPaused(false)
      .accounts({
        admin: admin.publicKey,
        gameConfig: gameConfigPda,
      })
      .signers([admin])
      .rpc();

    config = await program.account.gameConfig.fetch(gameConfigPda);
    assert.equal(config.paused, false, 'should be unpaused');
    console.log('✓ set_paused: pause/unpause works, blocks deposits when paused');
  });

  it('non-admin cannot pause the game', async () => {
    try {
      await program.methods
        .setPaused(true)
        .accounts({
          admin: player.publicKey, // player trying to act as admin
          gameConfig: gameConfigPda,
        })
        .signers([player])
        .rpc();
      assert.fail('Should have rejected non-admin');
    } catch (e: any) {
      assert.include(e.message, 'Unauthorized');
      console.log('✓ set_paused: non-admin rejected');
    }
  });

  // ── Test 7: Stats Verification ───────────────────────────────────────────────

  it('game stats are tracked correctly', async () => {
    const config = await program.account.gameConfig.fetch(gameConfigPda);
    console.log(`\nFinal game stats:`);
    console.log(`  Total bets: ${config.totalBets.toString()}`);
    console.log(`  Total wagered: ${toEmblem(BigInt(config.totalWagered.toString()))} EMBLEM`);
    console.log(`  Total paid out: ${toEmblem(BigInt(config.totalPaidOut.toString()))} EMBLEM`);
    console.log(`  House edge: ${config.houseEdgeBps / 100}%`);

    assert.isTrue(config.totalBets.toNumber() > 0, 'should have recorded bets');
    assert.isTrue(config.totalWagered.toNumber() > 0, 'should have recorded wagered amount');
    console.log('✓ stats: game metrics tracked correctly');
  });
});
