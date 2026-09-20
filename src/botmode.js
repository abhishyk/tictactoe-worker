// Play-with-Bot coin rewards. Per explicit instruction the bot itself is
// UNCHANGED — it's the unbeatable minimax AI in frontend/game.js, so in
// honest play a human can at best force a draw, never a true win. This
// endpoint pays out coins *whenever* a win is reported; whether that ends
// up being common or effectively never is a separate, later call — nothing
// here artificially blocks it.
//
// Trust model: Bot mode runs 100% client-side (see game.js's own comment —
// "purely local, nothing to send anywhere"), so the server never sees the
// moves as they happen. What it CAN do cheaply, without touching the bot's
// difficulty at all, is:
//   1. Re-check the claimed final board is actually a legal, finished,
//      "X just won" position (X is always the human in Bot mode) before
//      paying out anything — rejects a trivially wrong/forged board.
//   2. Cap total daily earnings from this source, so even a scripted,
//      repeated claim against this endpoint is worth at most
//      BOT_DAILY_EARN_CAP coins a day, never unlimited.
// This is NOT full move-by-move replay verification (that would require
// the bot's exact move sequence, which is a bigger change) — it's a cheap
// backstop appropriate for a low-stakes in-game currency.
//
// Wins/losses/total_matches are never touched here — by design this never
// affects the leaderboard, only the coin balance.
import { authenticateRequest } from './telegram.js';
import { getUserByTelegramId } from './auth.js';
import { json, unauthorized, badRequest } from './utils.js';

export const BOT_WIN_REWARD = 3;
export const BOT_DAILY_EARN_CAP = 300; // coins/day from Bot-mode wins, i.e. up to 100 wins/day

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function isLegitXWin(board) {
  if (!Array.isArray(board) || board.length !== 9) return false;
  if (!board.every((c) => c === null || c === 'X' || c === 'O')) return false;

  const xCount = board.filter((c) => c === 'X').length;
  const oCount = board.filter((c) => c === 'O').length;
  // X always moves first in Bot mode, so X can only ever be exactly one
  // move ahead of O — and the claimed winner (X) must be the one who just
  // moved, i.e. the move counts must reflect that.
  if (xCount !== oCount + 1) return false;

  const xWins = WIN_LINES.some(([a, b, c]) => board[a] === 'X' && board[b] === 'X' && board[c] === 'X');
  const oWins = WIN_LINES.some(([a, b, c]) => board[a] === 'O' && board[b] === 'O' && board[c] === 'O');
  return xWins && !oWins;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC calendar day
}

/** POST /api/bot-win — claim the coin reward for a Play-with-Bot win. */
export async function handleBotWin(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!isLegitXWin(body?.board)) {
    return badRequest('That board is not a valid win.');
  }

  const user = await getUserByTelegramId(env, auth.telegramId);
  if (!user) return badRequest('User not found');

  const day = todayUTC();

  // Single atomic upsert: creates today's row at BOT_WIN_REWARD the first
  // time, or bumps it only when doing so would stay at/under the daily cap.
  // When the cap is already hit, SQLite's "DO UPDATE ... WHERE" skips the
  // update (and there's no INSERT either, since the row already exists),
  // so `changes === 0` means exactly "capped for today" — race-safe the
  // same way every other coin deduction/credit in this codebase is.
  const claim = await env.DB.prepare(
    `INSERT INTO bot_earnings (telegram_id, day, coins_earned)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, day) DO UPDATE SET coins_earned = coins_earned + ?
     WHERE bot_earnings.coins_earned + ? <= ?`
  )
    .bind(auth.telegramId, day, BOT_WIN_REWARD, BOT_WIN_REWARD, BOT_WIN_REWARD, BOT_DAILY_EARN_CAP)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    return json({ awarded: false, reason: 'daily_cap_reached', coins: user.coins, cap: BOT_DAILY_EARN_CAP });
  }

  await env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?')
    .bind(BOT_WIN_REWARD, auth.telegramId)
    .run();

  const updated = await getUserByTelegramId(env, auth.telegramId);
  const row = await env.DB.prepare('SELECT coins_earned FROM bot_earnings WHERE telegram_id = ? AND day = ?')
    .bind(auth.telegramId, day)
    .first();

  return json({
    awarded: true,
    reward: BOT_WIN_REWARD,
    coins: updated.coins,
    earnedToday: row ? row.coins_earned : BOT_WIN_REWARD,
    cap: BOT_DAILY_EARN_CAP,
  });
}
