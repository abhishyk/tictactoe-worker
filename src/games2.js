// Coin rewards for the standalone mini-games (Rock Paper Scissors, 2048).
// Same trust model as botmode.js: no live multiplayer state, so a cheap
// per-day coin cap plus (where possible) a legality check is the backstop
// against scripted abuse — not full move-by-move replay.
import { authenticateRequest } from './telegram.js';
import { getUserByTelegramId } from './auth.js';
import { json, unauthorized, badRequest } from './utils.js';

export const RPS_WIN_REWARD = 1;
export const RPS_DAILY_EARN_CAP = 100; // up to 100 wins/day

export const GAME2048_WIN_REWARD = 3;
export const GAME2048_DAILY_EARN_CAP = 300; // up to 100 wins/day
export const GAME2048_WIN_TILE = 2048;

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC calendar day
}

// Atomically credits `reward` coins for `game` on today's UTC day, capped at
// `cap` coins/day — same INSERT ... ON CONFLICT ... WHERE pattern used by
// Bot mode's bot_earnings table (see botmode.js), just keyed by game too so
// each mini-game's daily cap is tracked independently of the others.
async function creditGameWin(env, telegramId, game, reward, cap) {
  const day = todayUTC();
  const claim = await env.DB.prepare(
    `INSERT INTO game_earnings (telegram_id, day, game, coins_earned)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id, day, game) DO UPDATE SET coins_earned = coins_earned + ?
     WHERE game_earnings.coins_earned + ? <= ?`
  )
    .bind(telegramId, day, game, reward, reward, reward, cap)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    return { awarded: false };
  }

  await env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?')
    .bind(reward, telegramId)
    .run();

  const updated = await getUserByTelegramId(env, telegramId);
  const row = await env.DB.prepare(
    'SELECT coins_earned FROM game_earnings WHERE telegram_id = ? AND day = ? AND game = ?'
  )
    .bind(telegramId, day, game)
    .first();

  return { awarded: true, coins: updated.coins, earnedToday: row ? row.coins_earned : reward };
}

/**
 * POST /api/rps/play — body: { choice: 'rock'|'paper'|'scissors' }
 * The server picks the bot's move itself and computes the outcome — it
 * never trusts a client-claimed result, so this endpoint is fully
 * authoritative and there is nothing for a client to forge.
 */
export async function handleRpsPlay(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const choices = ['rock', 'paper', 'scissors'];
  const playerChoice = body?.choice;
  if (!choices.includes(playerChoice)) return badRequest('Invalid choice');

  const botChoice = choices[Math.floor(Math.random() * 3)];

  let result; // 'win' | 'lose' | 'draw'
  if (playerChoice === botChoice) {
    result = 'draw';
  } else if (
    (playerChoice === 'rock' && botChoice === 'scissors') ||
    (playerChoice === 'paper' && botChoice === 'rock') ||
    (playerChoice === 'scissors' && botChoice === 'paper')
  ) {
    result = 'win';
  } else {
    result = 'lose';
  }

  if (result !== 'win') {
    return json({ result, botChoice, awarded: false });
  }

  const credit = await creditGameWin(env, auth.telegramId, 'rps', RPS_WIN_REWARD, RPS_DAILY_EARN_CAP);
  return json({
    result,
    botChoice,
    awarded: credit.awarded,
    reward: RPS_WIN_REWARD,
    coins: credit.coins,
    earnedToday: credit.earnedToday,
    cap: RPS_DAILY_EARN_CAP,
    reason: credit.awarded ? undefined : 'daily_cap_reached',
  });
}

/**
 * POST /api/2048-win — body: { board: number[16] } (flattened 4x4 grid,
 * 0 = empty). 2048 runs entirely client-side (no D1 involvement for the
 * actual gameplay), so — same spirit as Bot mode's board check in
 * botmode.js — this does a cheap legality backstop before paying out: every
 * non-zero cell must be a real power of two, and the claimed win tile must
 * actually be present. It is NOT full move-by-move replay, just enough to
 * reject a trivially forged board, backed by the same per-day cap as
 * everything else here.
 */
export async function handle2048Win(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const board = body?.board;
  if (!Array.isArray(board) || board.length !== 16) return badRequest('Invalid board');
  const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  if (!board.every((c) => c === 0 || isPow2(c))) return badRequest('Invalid board values');
  if (!board.some((c) => c >= GAME2048_WIN_TILE)) return badRequest('Board does not contain a winning tile');

  const credit = await creditGameWin(env, auth.telegramId, '2048', GAME2048_WIN_REWARD, GAME2048_DAILY_EARN_CAP);
  return json({
    awarded: credit.awarded,
    reward: GAME2048_WIN_REWARD,
    coins: credit.coins,
    earnedToday: credit.earnedToday,
    cap: GAME2048_DAILY_EARN_CAP,
    reason: credit.awarded ? undefined : 'daily_cap_reached',
  });
}
