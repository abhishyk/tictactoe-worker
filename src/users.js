// GET /api/me and GET /api/players — read-only user info, always sourced
// from D1, never from anything the client claims about itself.
import { authenticateRequest } from './telegram.js';
import { getOrCreateUser, publicUser } from './auth.js';
import { json, unauthorized, badRequest, nowSeconds, ONLINE_WINDOW_SECONDS } from './utils.js';

export async function handleMe(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const user = await getOrCreateUser(env, auth.telegramId, auth.username);

  // Surface any incoming challenge (invited-but-not-yet-accepted) so the
  // Mini App can prompt the user even if they opened the app directly
  // rather than through a Telegram group "Accept/Decline" message.
  const pending = await env.DB.prepare(
    `SELECT g.id as game_id, u.username as challenger_username, u.telegram_id as challenger_id
     FROM games g JOIN users u ON u.telegram_id = g.player1_id
     WHERE g.player2_id = ? AND g.status = 'pending' AND g.expires_at > ?
     ORDER BY g.created_at DESC LIMIT 1`
  )
    .bind(auth.telegramId, Math.floor(Date.now() / 1000))
    .first();

  return json({
    user: publicUser(user),
    pendingChallenge: pending
      ? { gameId: pending.game_id, challengerUsername: pending.challenger_username, challengerId: pending.challenger_id }
      : null,
  });
}

/** GET /api/players?q=search — search other players to challenge. */
export async function handlePlayers(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
  if (!q) return badRequest('Query parameter "q" is required');

  const onlineSince = nowSeconds() - ONLINE_WINDOW_SECONDS;

  const rows = await env.DB.prepare(
    `SELECT id, telegram_id, username, wins, total_matches, last_seen_at
     FROM users
     WHERE username LIKE ? AND telegram_id != ?
     ORDER BY (last_seen_at > ?) DESC, wins DESC
     LIMIT 20`
  )
    .bind(`%${q}%`, auth.telegramId, onlineSince)
    .all();

  const players = (rows.results || []).map((r) => ({
    id: r.id,
    telegramId: r.telegram_id,
    username: r.username,
    wins: r.wins,
    totalMatches: r.total_matches,
    isOnline: r.last_seen_at > onlineSince,
    // Whether *this* challenger can afford to invite is a client-side hint
    // only — the real check happens again server-side on POST /api/challenge.
  }));

  return json({ players });
}
