// Auth: Telegram initData -> D1 user identity. No frontend-supplied coin/user
// data is ever trusted; the user row is looked up (or created) strictly by
// the telegram_id extracted from server-validated initData.
import { generateId, nowSeconds, STARTING_COINS, sanitizeUsername } from './utils.js';
import { validateInitData } from './telegram.js';
import { json, unauthorized } from './utils.js';

export async function getUserByTelegramId(env, telegramId) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first();
  return row || null;
}

export async function getUserById(env, id) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return row || null;
}

/**
 * Looks up a user by their Telegram @username (case-insensitive, exact match).
 * Only finds people who have already talked to the bot at least once (i.e.
 * they exist in our `users` table) — Telegram itself never lets a bot resolve
 * an arbitrary @username to an id, so this is the only reliable way. Used as
 * the /challenge @username fallback for groups where reply-based detection
 * is blocked by the target's own Telegram privacy settings.
 */
export async function getUserByUsername(env, username) {
  const clean = (username || '').replace(/^@/, '').trim();
  if (!clean) return null;
  const row = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(clean)
    .first();
  return row || null;
}

/**
 * Looks up a user by Telegram id, creating them with the starting coin grant
 * if this is their first time opening the Mini App. Only this function may
 * insert the initial balance — the frontend never sets it.
 */
export async function getOrCreateUser(env, telegramId, username) {
  const existing = await getUserByTelegramId(env, telegramId);
  const now = nowSeconds();

  if (existing) {
    // Keep username fresh (people change their Telegram @handle) and stamp
    // last_seen_at every time we identify them — this is what powers the
    // "online now" list in Find Player (see users.js). No new table needed.
    const cleaned = sanitizeUsername(username) || existing.username;
    await env.DB.prepare('UPDATE users SET username = ?, last_seen_at = ? WHERE id = ?')
      .bind(cleaned, now, existing.id)
      .run();
    existing.username = cleaned;
    existing.last_seen_at = now;
    return existing;
  }

  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO users (id, telegram_id, username, coins, total_matches, wins, losses, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
  )
    .bind(id, telegramId, sanitizeUsername(username), STARTING_COINS, now, now)
    .run();

  return getUserByTelegramId(env, telegramId);
}

/** POST /api/auth — validates initData and returns the identified user. */
export async function handleAuth(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const initData = body?.initData || request.headers.get('X-Telegram-Init-Data');
  const parsed = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!parsed) return unauthorized('Invalid or expired Telegram init data');

  const user = await getOrCreateUser(env, parsed.telegramId, parsed.username);

  return json({
    user: publicUser(user),
    startParam: parsed.startParam,
  });
}

/** Strips fields we never want to hand to the client wholesale. */
export function publicUser(user) {
  return {
    id: user.id,
    telegramId: user.telegram_id,
    username: user.username,
    coins: user.coins,
    totalMatches: user.total_matches,
    wins: user.wins,
    losses: user.losses,
  };
}
