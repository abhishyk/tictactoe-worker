-- Tic Tac Toe Mini App — D1 Schema
-- Permanent table: users. Temporary table: games (cleaned up by cron).

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    username TEXT,
    coins INTEGER NOT NULL DEFAULT 100,
    total_matches INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_wins ON users(wins DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);

-- status: pending | accepted | started | completed | expired | cancelled
-- result_p1 / result_p2 hold each player's own self-reported outcome
-- ('win' | 'loss' | 'draw') for the round they just played. Since the board
-- is intentionally never stored server-side (see spec), settlement is only
-- finalized once both sides' reports are in and agree with each other —
-- this is what lets the backend "verify" a result without trusting a
-- single client's claim.
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    player1_id TEXT NOT NULL,
    player2_id TEXT,
    status TEXT NOT NULL,
    winner_id TEXT,
    result_p1 TEXT,
    result_p2 TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_expires_at ON games(expires_at);
CREATE INDEX IF NOT EXISTS idx_games_player1 ON games(player1_id);
CREATE INDEX IF NOT EXISTS idx_games_player2 ON games(player2_id);

-- Buy Coins (Telegram Stars). One row per successfully processed Stars
-- payment. `charge_id` is Telegram's own unique id for that payment
-- (telegram_payment_charge_id) and is the PRIMARY KEY specifically so a
-- duplicate webhook delivery for the same payment can never credit coins
-- twice — the INSERT itself fails on the second attempt.
CREATE TABLE IF NOT EXISTS payments (
    charge_id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    stars INTEGER NOT NULL,
    coins_credited INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_telegram_id ON payments(telegram_id);
