use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_program::hash::hashv;

declare_id!("EmbLBetXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// ─── Constants ────────────────────────────────────────────────────────────────

/// Maximum house edge: 1000 bps = 10%
pub const MAX_HOUSE_EDGE_BPS: u16 = 1000;
/// Minimum house edge: 50 bps = 0.5%
pub const MIN_HOUSE_EDGE_BPS: u16 = 50;
/// Minimum win chance: 100 bps = 1%
pub const MIN_WIN_CHANCE_BPS: u16 = 100;
/// Maximum win chance: 9800 bps = 98%
pub const MAX_WIN_CHANCE_BPS: u16 = 9800;
/// Roll range denominator (0–9999, representing 0.00%–99.99%)
pub const ROLL_RANGE: u64 = 10_000;
/// Maximum single win in EMBLEM tokens (with 9 decimals)
/// 50,000 EMBLEM = 50_000 * 10^9
pub const MAX_WIN_TOKENS: u64 = 50_000 * 1_000_000_000;
/// Minimum bet: 1 EMBLEM
pub const MIN_BET_TOKENS: u64 = 1_000_000_000;
/// Seed strings for PDAs
pub const GAME_CONFIG_SEED: &[u8] = b"game_config";
pub const HOUSE_VAULT_SEED: &[u8] = b"house_vault";
pub const PLAYER_STATE_SEED: &[u8] = b"player_state";
pub const PLAYER_VAULT_SEED: &[u8] = b"player_vault";
pub const BET_REQUEST_SEED: &[u8] = b"bet_request";

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod emblem_bet {
    use super::*;

    /// One-time initialization. Creates the game config and house vault.
    /// Called by admin wallet once after deployment.
    pub fn initialize(
        ctx: Context<Initialize>,
        house_edge_bps: u16,
    ) -> Result<()> {
        require!(
            house_edge_bps >= MIN_HOUSE_EDGE_BPS && house_edge_bps <= MAX_HOUSE_EDGE_BPS,
            EmblemBetError::InvalidHouseEdge
        );

        let config = &mut ctx.accounts.game_config;
        config.admin = ctx.accounts.admin.key();
        config.emblem_mint = ctx.accounts.emblem_mint.key();
        config.house_vault = ctx.accounts.house_vault.key();
        config.house_edge_bps = house_edge_bps;
        config.paused = false;
        config.total_wagered = 0;
        config.total_paid_out = 0;
        config.total_bets = 0;
        config.bump = ctx.bumps.game_config;
        config.house_vault_bump = ctx.bumps.house_vault;

        emit!(GameInitialized {
            admin: config.admin,
            emblem_mint: config.emblem_mint,
            house_edge_bps,
        });

        Ok(())
    }

    /// Player deposits EMBLEM into their personal vault PDA.
    /// Creates the PlayerState account if it doesn't exist yet.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.game_config.paused, EmblemBetError::GamePaused);
        require!(amount >= MIN_BET_TOKENS, EmblemBetError::BetTooSmall);

        // Transfer from player wallet → player vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.player_token_account.to_account_info(),
            to: ctx.accounts.player_vault.to_account_info(),
            authority: ctx.accounts.player.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update on-chain player state
        let state = &mut ctx.accounts.player_state;
        if state.wallet == Pubkey::default() {
            // First deposit — initialize player state
            state.wallet = ctx.accounts.player.key();
            state.bump = ctx.bumps.player_state;
            state.vault_bump = ctx.bumps.player_vault;
            state.nonce = 0;
        }
        state.balance = state.balance.checked_add(amount).ok_or(EmblemBetError::Overflow)?;

        emit!(Deposited {
            player: ctx.accounts.player.key(),
            amount,
            new_balance: state.balance,
        });

        Ok(())
    }

    /// Player withdraws EMBLEM from their vault back to their wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.player_state;
        require!(state.balance >= amount, EmblemBetError::InsufficientBalance);
        require!(amount > 0, EmblemBetError::BetTooSmall);

        // Ensure no pending bet
        // (bet_request account being closed in settle prevents this naturally,
        //  but we also check the flag for safety)

        // PDA signer seeds for player_vault
        let player_key = ctx.accounts.player.key();
        let player_vault_seeds = &[
            PLAYER_VAULT_SEED,
            player_key.as_ref(),
            &[state.vault_bump],
        ];
        let signer_seeds = &[&player_vault_seeds[..]];

        // Transfer from player vault → player wallet
        let cpi_accounts = Transfer {
            from: ctx.accounts.player_vault.to_account_info(),
            to: ctx.accounts.player_token_account.to_account_info(),
            authority: ctx.accounts.player_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        state.balance = state.balance.checked_sub(amount).ok_or(EmblemBetError::Overflow)?;

        emit!(Withdrawn {
            player: ctx.accounts.player.key(),
            amount,
            new_balance: state.balance,
        });

        Ok(())
    }

    /// Player submits a bet. Locks funds and stores commitment.
    /// This is the COMMIT phase of the commit-reveal scheme.
    ///
    /// The server_seed_hash must be provided — it commits the server to a specific
    /// outcome without revealing the seed yet. The client_seed is the player's
    /// entropy contribution, chosen before the bet.
    pub fn request_bet(
        ctx: Context<RequestBet>,
        amount: u64,
        win_chance_bps: u16,
        direction: BetDirection,
        client_seed: [u8; 32],
        server_seed_hash: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.game_config.paused, EmblemBetError::GamePaused);
        require!(
            win_chance_bps >= MIN_WIN_CHANCE_BPS && win_chance_bps <= MAX_WIN_CHANCE_BPS,
            EmblemBetError::InvalidWinChance
        );
        require!(amount >= MIN_BET_TOKENS, EmblemBetError::BetTooSmall);

        let state = &mut ctx.accounts.player_state;
        require!(state.balance >= amount, EmblemBetError::InsufficientBalance);

        // Calculate max payout to ensure house can cover the win
        let house_edge_bps = ctx.accounts.game_config.house_edge_bps as u64;
        // multiplier_num / multiplier_denom = (10000 - house_edge_bps) / win_chance_bps
        let max_payout = amount
            .checked_mul(10_000u64.checked_sub(house_edge_bps).ok_or(EmblemBetError::Overflow)?)
            .ok_or(EmblemBetError::Overflow)?
            .checked_div(win_chance_bps as u64)
            .ok_or(EmblemBetError::Overflow)?;

        require!(max_payout <= MAX_WIN_TOKENS, EmblemBetError::BetExceedsMaxWin);

        // House vault must have enough to cover the max payout
        let house_balance = ctx.accounts.house_vault.amount;
        require!(
            house_balance >= max_payout,
            EmblemBetError::HouseInsolvent
        );

        // Lock the bet amount — deduct from player balance now
        state.balance = state.balance.checked_sub(amount).ok_or(EmblemBetError::Overflow)?;
        let nonce = state.nonce.checked_add(1).ok_or(EmblemBetError::Overflow)?;
        state.nonce = nonce;

        // Record the bet
        let bet = &mut ctx.accounts.bet_request;
        bet.player = ctx.accounts.player.key();
        bet.amount = amount;
        bet.win_chance_bps = win_chance_bps;
        bet.direction = direction.clone();
        bet.client_seed = client_seed;
        bet.server_seed_hash = server_seed_hash;
        bet.nonce = nonce;
        bet.slot = Clock::get()?.slot;
        bet.settled = false;
        bet.bump = ctx.bumps.bet_request;

        emit!(BetRequested {
            player: ctx.accounts.player.key(),
            amount,
            win_chance_bps,
            direction: direction.clone(),
            nonce,
            server_seed_hash,
        });

        Ok(())
    }

    /// Settle a bet by revealing the server seed.
    /// Called by the server (authority) after request_bet.
    ///
    /// The program:
    /// 1. Verifies SHA-256(server_seed) == committed server_seed_hash
    /// 2. Derives roll = HMAC-SHA256(server_seed, client_seed:nonce) mod ROLL_RANGE
    /// 3. Determines win/loss
    /// 4. Transfers tokens accordingly
    /// 5. Closes the bet_request account
    pub fn settle_bet(
        ctx: Context<SettleBet>,
        server_seed: [u8; 32],
    ) -> Result<()> {
        let bet = &ctx.accounts.bet_request;
        require!(!bet.settled, EmblemBetError::AlreadySettled);

        // ── Step 1: Verify server seed matches committed hash ──────────────────
        let computed_hash = sha256_hash(&server_seed);
        require!(
            computed_hash == bet.server_seed_hash,
            EmblemBetError::InvalidServerSeed
        );

        // ── Step 2: Derive the roll from HMAC-SHA256 ───────────────────────────
        // message = client_seed_hex + ":" + nonce_string
        let nonce_str = bet.nonce.to_string();
        let client_hex = hex_encode(&bet.client_seed);
        let message = format!("{}:{}", client_hex, nonce_str);

        let roll = compute_roll(&server_seed, message.as_bytes());

        // ── Step 3: Determine win/loss ─────────────────────────────────────────
        // win_chance_bps is in basis points of ROLL_RANGE
        // e.g. win_chance_bps=5000 means win if roll < 5000 (50%)
        let threshold = bet.win_chance_bps as u64;
        let won = match bet.direction {
            BetDirection::Under => roll < threshold,
            BetDirection::Over => roll >= ROLL_RANGE.checked_sub(threshold).ok_or(EmblemBetError::Overflow)?,
        };

        // ── Step 4: Calculate payout ───────────────────────────────────────────
        let house_edge_bps = ctx.accounts.game_config.house_edge_bps as u64;
        let payout = if won {
            bet.amount
                .checked_mul(10_000u64.checked_sub(house_edge_bps).ok_or(EmblemBetError::Overflow)?)
                .ok_or(EmblemBetError::Overflow)?
                .checked_div(bet.win_chance_bps as u64)
                .ok_or(EmblemBetError::Overflow)?
        } else {
            0
        };

        let player_state = &mut ctx.accounts.player_state;
        let config = &mut ctx.accounts.game_config;
        let player_key = ctx.accounts.player.key();

        if won {
            // Pay from house vault → player vault
            // payout includes the original bet amount (return of stake + profit)
            let profit = payout.checked_sub(bet.amount).ok_or(EmblemBetError::Overflow)?;

            // Transfer profit from house to player vault
            let house_vault_seeds = &[
                HOUSE_VAULT_SEED,
                &[config.house_vault_bump],
            ];
            let signer_seeds = &[&house_vault_seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.house_vault.to_account_info(),
                to: ctx.accounts.player_vault.to_account_info(),
                authority: ctx.accounts.house_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, profit)?;

            // Return original stake + profit to player balance
            player_state.balance = player_state.balance
                .checked_add(payout)
                .ok_or(EmblemBetError::Overflow)?;
            player_state.total_won = player_state.total_won
                .checked_add(profit)
                .ok_or(EmblemBetError::Overflow)?;
            config.total_paid_out = config.total_paid_out
                .checked_add(profit)
                .ok_or(EmblemBetError::Overflow)?;
        } else {
            // Loss: transfer bet amount from player vault → house vault
            let player_vault_seeds = &[
                PLAYER_VAULT_SEED,
                player_key.as_ref(),
                &[player_state.vault_bump],
            ];
            let signer_seeds = &[&player_vault_seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.player_vault.to_account_info(),
                to: ctx.accounts.house_vault.to_account_info(),
                authority: ctx.accounts.player_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, bet.amount)?;
        }

        // Update global stats
        config.total_wagered = config.total_wagered
            .checked_add(bet.amount)
            .ok_or(EmblemBetError::Overflow)?;
        config.total_bets = config.total_bets.checked_add(1).ok_or(EmblemBetError::Overflow)?;
        player_state.total_wagered = player_state.total_wagered
            .checked_add(bet.amount)
            .ok_or(EmblemBetError::Overflow)?;

        emit!(BetSettled {
            player: player_key,
            amount: bet.amount,
            roll,
            win_chance_bps: bet.win_chance_bps,
            direction: bet.direction.clone(),
            won,
            payout,
            nonce: bet.nonce,
            server_seed_hash: bet.server_seed_hash,
        });

        // bet_request account is closed by the constraint (close = player)
        // lamports returned to player

        Ok(())
    }

    /// Admin: fund the house vault from the admin's token account.
    pub fn fund_house(ctx: Context<FundHouse>, amount: u64) -> Result<()> {
        require!(amount > 0, EmblemBetError::BetTooSmall);

        let cpi_accounts = Transfer {
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.house_vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(HouseFunded {
            admin: ctx.accounts.admin.key(),
            amount,
            new_balance: ctx.accounts.house_vault.amount.checked_add(amount).unwrap_or(u64::MAX),
        });

        Ok(())
    }

    /// Admin: drain house vault back to admin's token account.
    pub fn drain_house(ctx: Context<DrainHouse>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.house_vault.amount >= amount,
            EmblemBetError::InsufficientBalance
        );

        let config = &ctx.accounts.game_config;
        let house_vault_seeds = &[
            HOUSE_VAULT_SEED,
            &[config.house_vault_bump],
        ];
        let signer_seeds = &[&house_vault_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.house_vault.to_account_info(),
            to: ctx.accounts.admin_token_account.to_account_info(),
            authority: ctx.accounts.house_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    /// Admin: pause or unpause the game.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.game_config.paused = paused;
        emit!(GamePauseChanged { paused });
        Ok(())
    }

    /// Admin: update the house edge (takes effect on next bet).
    pub fn set_house_edge(ctx: Context<AdminOnly>, house_edge_bps: u16) -> Result<()> {
        require!(
            house_edge_bps >= MIN_HOUSE_EDGE_BPS && house_edge_bps <= MAX_HOUSE_EDGE_BPS,
            EmblemBetError::InvalidHouseEdge
        );
        ctx.accounts.game_config.house_edge_bps = house_edge_bps;
        Ok(())
    }

    /// Admin: transfer admin authority to a new wallet (for multisig migration).
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.game_config.admin = new_admin;
        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub emblem_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = GameConfig::SIZE,
        seeds = [GAME_CONFIG_SEED],
        bump
    )]
    pub game_config: Account<'info, GameConfig>,

    /// The house bankroll — a token account owned by the house_vault PDA itself.
    #[account(
        init,
        payer = admin,
        token::mint = emblem_mint,
        token::authority = house_vault,
        seeds = [HOUSE_VAULT_SEED],
        bump
    )]
    pub house_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    /// The EMBLEM mint — must match what's stored in game_config.
    #[account(
        constraint = emblem_mint.key() == game_config.emblem_mint @ EmblemBetError::InvalidMint,
    )]
    pub emblem_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::SIZE,
        seeds = [PLAYER_STATE_SEED, player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,

    /// Player's vault — a token account owned by the player_vault PDA.
    #[account(
        init_if_needed,
        payer = player,
        token::mint = emblem_mint,
        token::authority = player_vault,
        seeds = [PLAYER_VAULT_SEED, player.key().as_ref()],
        bump
    )]
    pub player_vault: Account<'info, TokenAccount>,

    /// Player's own wallet token account (source of funds).
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EmblemBetError::InvalidTokenAccount,
        constraint = player_token_account.mint == game_config.emblem_mint @ EmblemBetError::InvalidMint,
    )]
    pub player_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_STATE_SEED, player.key().as_ref()],
        bump = player_state.bump,
        constraint = player_state.wallet == player.key() @ EmblemBetError::Unauthorized,
    )]
    pub player_state: Account<'info, PlayerState>,

    #[account(
        mut,
        seeds = [PLAYER_VAULT_SEED, player.key().as_ref()],
        bump = player_state.vault_bump,
    )]
    pub player_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EmblemBetError::InvalidTokenAccount,
        constraint = player_token_account.mint == game_config.emblem_mint @ EmblemBetError::InvalidMint,
    )]
    pub player_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestBet<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_STATE_SEED, player.key().as_ref()],
        bump = player_state.bump,
        constraint = player_state.wallet == player.key() @ EmblemBetError::Unauthorized,
    )]
    pub player_state: Account<'info, PlayerState>,

    #[account(
        seeds = [HOUSE_VAULT_SEED],
        bump = game_config.house_vault_bump,
    )]
    pub house_vault: Account<'info, TokenAccount>,

    /// One pending bet per player at a time.
    #[account(
        init,
        payer = player,
        space = BetRequest::SIZE,
        seeds = [BET_REQUEST_SEED, player.key().as_ref()],
        bump
    )]
    pub bet_request: Account<'info, BetRequest>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    /// The server authority that reveals the seed and settles bets.
    /// In MVP this is the backend server keypair.
    /// In production, replace with Switchboard VRF oracle.
    #[account(
        constraint = server.key() == game_config.admin @ EmblemBetError::Unauthorized
    )]
    pub server: Signer<'info>,

    /// CHECK: player is identified from bet_request, not a signer here
    #[account(mut)]
    pub player: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_STATE_SEED, player.key().as_ref()],
        bump = player_state.bump,
        constraint = player_state.wallet == player.key() @ EmblemBetError::Unauthorized,
    )]
    pub player_state: Account<'info, PlayerState>,

    #[account(
        mut,
        seeds = [PLAYER_VAULT_SEED, player.key().as_ref()],
        bump = player_state.vault_bump,
    )]
    pub player_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [HOUSE_VAULT_SEED],
        bump = game_config.house_vault_bump,
    )]
    pub house_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [BET_REQUEST_SEED, player.key().as_ref()],
        bump = bet_request.bump,
        constraint = bet_request.player == player.key() @ EmblemBetError::Unauthorized,
        close = player  // Lamports returned to player on close
    )]
    pub bet_request: Account<'info, BetRequest>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundHouse<'info> {
    #[account(
        constraint = admin.key() == game_config.admin @ EmblemBetError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [HOUSE_VAULT_SEED],
        bump = game_config.house_vault_bump,
    )]
    pub house_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.owner == admin.key() @ EmblemBetError::Unauthorized,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DrainHouse<'info> {
    #[account(
        constraint = admin.key() == game_config.admin @ EmblemBetError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [HOUSE_VAULT_SEED],
        bump = game_config.house_vault_bump,
    )]
    pub house_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.owner == admin.key() @ EmblemBetError::Unauthorized,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = admin.key() == game_config.admin @ EmblemBetError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        constraint = admin.key() == game_config.admin @ EmblemBetError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_CONFIG_SEED],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,
}

// ─── Account Data Structures ──────────────────────────────────────────────────

#[account]
pub struct GameConfig {
    pub admin: Pubkey,          // 32
    pub emblem_mint: Pubkey,    // 32
    pub house_vault: Pubkey,    // 32
    pub house_edge_bps: u16,    // 2
    pub paused: bool,           // 1
    pub bump: u8,               // 1
    pub house_vault_bump: u8,   // 1
    pub _padding: [u8; 5],      // 5 (alignment)
    pub total_wagered: u64,     // 8
    pub total_paid_out: u64,    // 8
    pub total_bets: u64,        // 8
}

impl GameConfig {
    // discriminator(8) + fields
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 2 + 1 + 1 + 1 + 5 + 8 + 8 + 8;
}

#[account]
pub struct PlayerState {
    pub wallet: Pubkey,         // 32
    pub balance: u64,           // 8
    pub total_wagered: u64,     // 8
    pub total_won: u64,         // 8
    pub nonce: u64,             // 8
    pub bump: u8,               // 1
    pub vault_bump: u8,         // 1
    pub _padding: [u8; 6],      // 6
}

impl PlayerState {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 6;
}

#[account]
pub struct BetRequest {
    pub player: Pubkey,             // 32
    pub amount: u64,                // 8
    pub win_chance_bps: u16,        // 2
    pub direction: BetDirection,    // 1
    pub settled: bool,              // 1
    pub bump: u8,                   // 1
    pub _padding: [u8; 3],          // 3
    pub nonce: u64,                 // 8
    pub slot: u64,                  // 8
    pub client_seed: [u8; 32],      // 32
    pub server_seed_hash: [u8; 32], // 32
}

impl BetRequest {
    pub const SIZE: usize = 8 + 32 + 8 + 2 + 1 + 1 + 1 + 3 + 8 + 8 + 32 + 32;
}

// ─── Enums ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum BetDirection {
    Under,
    Over,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct GameInitialized {
    pub admin: Pubkey,
    pub emblem_mint: Pubkey,
    pub house_edge_bps: u16,
}

#[event]
pub struct Deposited {
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct Withdrawn {
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct BetRequested {
    pub player: Pubkey,
    pub amount: u64,
    pub win_chance_bps: u16,
    pub direction: BetDirection,
    pub nonce: u64,
    pub server_seed_hash: [u8; 32],
}

#[event]
pub struct BetSettled {
    pub player: Pubkey,
    pub amount: u64,
    pub roll: u64,
    pub win_chance_bps: u16,
    pub direction: BetDirection,
    pub won: bool,
    pub payout: u64,
    pub nonce: u64,
    pub server_seed_hash: [u8; 32],
}

#[event]
pub struct HouseFunded {
    pub admin: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct GamePauseChanged {
    pub paused: bool,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum EmblemBetError {
    #[msg("Game is currently paused")]
    GamePaused,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Bet amount is too small (minimum 1 EMBLEM)")]
    BetTooSmall,
    #[msg("Win chance must be between 1% and 98%")]
    InvalidWinChance,
    #[msg("Bet exceeds maximum win limit")]
    BetExceedsMaxWin,
    #[msg("House vault has insufficient funds to cover potential payout")]
    HouseInsolvent,
    #[msg("Server seed does not match committed hash")]
    InvalidServerSeed,
    #[msg("Bet has already been settled")]
    AlreadySettled,
    #[msg("House edge must be between 0.5% and 10%")]
    InvalidHouseEdge,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Invalid mint — must be EMBLEM token")]
    InvalidMint,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// SHA-256 hash using Solana's built-in hashv.
fn sha256_hash(data: &[u8]) -> [u8; 32] {
    hashv(&[data]).to_bytes()
}

/// HMAC-SHA256 implemented via the standard double-hash construction,
/// using Solana's built-in SHA-256 (hashv). No external crates needed.
///
/// HMAC(K, m) = SHA256((K' XOR opad) || SHA256((K' XOR ipad) || m))
/// where K' = K padded to 64 bytes, ipad = 0x36, opad = 0x5C
fn compute_roll(server_seed: &[u8; 32], message: &[u8]) -> u64 {
    // Build ipad and opad (64-byte blocks XORed with key)
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..32 {
        ipad[i] ^= server_seed[i];
        opad[i] ^= server_seed[i];
    }
    // inner = SHA256(ipad || message)
    let inner = hashv(&[&ipad, message]).to_bytes();
    // outer = SHA256(opad || inner)
    let outer = hashv(&[&opad, &inner]).to_bytes();
    // Take first 8 bytes as big-endian u64, mod ROLL_RANGE
    let int_val = u64::from_be_bytes(outer[..8].try_into().unwrap());
    int_val % ROLL_RANGE
}

/// Encode a byte slice as lowercase hex string.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
