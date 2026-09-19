import { authenticateRequest } from './telegram.js';
import { json, unauthorized } from './utils.js';

export async function getLeaderboard(env, limit = 50) {
  const rows = await env.DB.prepare(
    `SELECT telegram_id, username, wins, total_matches
     FROM users
     ORDER BY wins DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return rows.results || [];
}

/** GET /api/leaderboard — top 50 players by wins. */
export async function handleLeaderboard(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const rows = await getLeaderboard(env, 50);
  const leaderboard = rows.map((r, i) => ({
    rank: i + 1,
    telegramId: r.telegram_id,
    username: r.username,
    wins: r.wins,
    totalMatches: r.total_matches,
  }));

  return json({ leaderboard });
}
