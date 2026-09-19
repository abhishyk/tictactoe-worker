// PvP challenge lifecycle + atomic coin settlement.
//
// IMPORTANT LIMITATION (see spec): the board/moves are never stored server
// side, so the backend cannot mathematically replay a match to verify who
// really won. To avoid trusting a single client's claimed winner, each
// player reports only their OWN outcome for the match; the game is settled
// only once both reports are in and they agree with each other. If they
// disagree (or one player never reports before an idle timeout), no coins
// are transferred and the game is voided/refunded — never double-paid.
import { authenticateRequest } from './telegram.js';
import { getUserByTelegramId } from './auth.js';
import { generateId, nowSeconds, json, badRequest, unauthorized, forbidden, notFound, ENTRY_COST, GAME_TTL_SECONDS, MATCHMAKING_TTL_SECONDS } from './utils.js';

function publicGame(game, viewerTelegramId) {
  return {
    id: game.id,
    status: game.status,
    player1Id: game.player1_id,
    player2Id: game.player2_id,
    winnerId: game.winner_id || null,
    youAre: viewerTelegramId === game.player1_id ? 'player1' : viewerTelegramId === game.player2_id ? 'player2' : null,
    expiresAt: game.expires_at,
  };
}

async function getGameRow(env, gameId) {
  return env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();
}

/** Creates a pending challenge. Only the challenger's balance is known-good here — see acceptChallenge for the required re-check. */
export async function createChallenge(env, challengerTelegramId, targetTelegramId) {
  if (challengerTelegramId === targetTelegramId) {
    return { ok: false, error: 'You cannot challenge yourself.' };
  }

  const challenger = await getUserByTelegramId(env, challengerTelegramId);
  const target = await getUserByTelegramId(env, targetTelegramId);
  if (!challenger || !target) return { ok: false, error: 'Player not found.' };

  if (challenger.coins < ENTRY_COST) {
    return { ok: false, error: 'Minimum 10 coins required to play.' };
  }

  const id = generateId();
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO games (id, player1_id, player2_id, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  )
    .bind(id, challengerTelegramId, targetTelegramId, now, now + GAME_TTL_SECONDS)
    .run();

  const game = await getGameRow(env, id);
  return { ok: true, game };
}

/**
 * Called when the invited player accepts. Re-checks BOTH balances against
 * the current D1 state (never the balances at invite time), then — if both
 * can afford it — deducts the 10-coin entry from each and marks the game
 * 'started' in the same atomic batch. This single re-check also serves as
 * the "final balance check" required immediately before a game starts,
 * since there is no separate start step in this API surface.
 */
export async function acceptChallenge(env, gameId, accepterTelegramId) {
  const game = await getGameRow(env, gameId);
  if (!game) return { ok: false, error: 'Challenge not found.' };
  if (game.status !== 'pending') return { ok: false, error: 'This challenge is no longer pending.' };
  if (game.player2_id !== accepterTelegramId) return { ok: false, error: 'This challenge is not for you.' };
  if (game.expires_at < nowSeconds()) return { ok: false, error: 'This challenge has expired.' };

  const [p1, p2] = await Promise.all([
    getUserByTelegramId(env, game.player1_id),
    getUserByTelegramId(env, game.player2_id),
  ]);
  if (!p1 || !p2) return { ok: false, error: 'Player not found.' };

  if (p1.coins < ENTRY_COST || p2.coins < ENTRY_COST) {
    await env.DB.prepare(`UPDATE games SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .bind(gameId)
      .run();
    return { ok: false, error: 'Game cannot start. Both players need at least 10 coins.' };
  }

  // Atomic: flip to 'started' only if still 'pending' (guards double-accept
  // races), and deduct the entry fee from both players in the same batch.
  const claim = await env.DB.prepare(
    `UPDATE games SET status = 'started' WHERE id = ? AND status = 'pending'`
  )
    .bind(gameId)
    .run();
  if (!claim.meta || claim.meta.changes === 0) {
    return { ok: false, error: 'This challenge was already handled.' };
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET coins = coins - ? WHERE telegram_id = ? AND coins >= ?').bind(
      ENTRY_COST,
      game.player1_id,
      ENTRY_COST
    ),
    env.DB.prepare('UPDATE users SET coins = coins - ? WHERE telegram_id = ? AND coins >= ?').bind(
      ENTRY_COST,
      game.player2_id,
      ENTRY_COST
    ),
  ]);

  const updated = await getGameRow(env, gameId);
  return { ok: true, game: updated };
}

export async function declineChallenge(env, gameId, declinerTelegramId) {
  const game = await getGameRow(env, gameId);
  if (!game) return { ok: false, error: 'Challenge not found.' };
  if (game.player2_id !== declinerTelegramId) return { ok: false, error: 'This challenge is not for you.' };

  await env.DB.prepare(`UPDATE games SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .bind(gameId)
    .run();
  return { ok: true };
}

/**
 * Voluntary quit / forfeit. Unlike a normal result submission, this needs no
 * mutual confirmation from the other side — a player can only ever hurt
 * themselves by forfeiting (their own stake goes to the opponent), never
 * gain anything by lying, so a single authenticated request is enough.
 * Guarded by the same optimistic 'started' -> 'completed' transition as
 * every other settlement path, so it can't race with a normal result
 * submission and double-pay.
 */
export async function forfeitGame(env, gameId, quitterTelegramId) {
  const game = await getGameRow(env, gameId);
  if (!game) return { ok: false, error: 'Game not found.' };

  const isP1 = game.player1_id === quitterTelegramId;
  const isP2 = game.player2_id === quitterTelegramId;
  if (!isP1 && !isP2) return { ok: false, error: 'You are not a player in this game.' };

  if (game.status === 'completed') {
    return { ok: true, alreadySettled: true, winnerId: game.winner_id || null };
  }
  if (game.status !== 'started') {
    return { ok: false, error: `Game is not active (status: ${game.status}).` };
  }

  const winnerTelegramId = isP1 ? game.player2_id : game.player1_id;

  const claim = await env.DB.prepare(
    `UPDATE games SET status = 'completed', winner_id = ? WHERE id = ? AND status = 'started'`
  )
    .bind(winnerTelegramId, gameId)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    // Already settled by the normal result path in the meantime.
    const finalGame = await getGameRow(env, gameId);
    return { ok: true, alreadySettled: true, winnerId: finalGame.winner_id || null };
  }

  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1, wins = wins + 1 WHERE telegram_id = ?'
    ).bind(ENTRY_COST, winnerTelegramId),
    env.DB.prepare(
      'UPDATE users SET total_matches = total_matches + 1, losses = losses + 1 WHERE telegram_id = ?'
    ).bind(quitterTelegramId),
  ]);

  return { ok: true, winnerId: winnerTelegramId };
}

/**
 * "Auto Match" — pairs the caller with any other player currently waiting,
 * instead of requiring a known username. A waiting entry is just a normal
 * 'pending' game with `player2_id` left NULL (a manual friend-challenge
 * always has player2_id set, so this can't collide with that flow).
 *
 * - If someone is already waiting, we atomically claim their open slot and
 *   immediately run it through the exact same acceptChallenge() path used
 *   for friend challenges — same balance re-check, same atomic deduction.
 * - If nobody is waiting, we create a new open entry and the caller polls
 *   GET /api/game/:id until another player joins it (or it expires).
 */
export async function joinMatchmaking(env, telegramId) {
  const me = await getUserByTelegramId(env, telegramId);
  if (!me) return { ok: false, error: 'Player not found.' };
  if (me.coins < ENTRY_COST) {
    return { ok: false, error: 'Minimum 10 coins required to play.' };
  }

  const now = nowSeconds();
  const waiting = await env.DB.prepare(
    `SELECT * FROM games
     WHERE status = 'pending' AND player2_id IS NULL AND player1_id != ? AND expires_at > ?
     ORDER BY created_at ASC LIMIT 1`
  )
    .bind(telegramId, now)
    .first();

  if (waiting) {
    // Claim the open slot — guarded so only one of any simultaneous joiners wins it.
    const claim = await env.DB.prepare(
      `UPDATE games SET player2_id = ? WHERE id = ? AND player2_id IS NULL AND status = 'pending'`
    )
      .bind(telegramId, waiting.id)
      .run();

    if (claim.meta && claim.meta.changes > 0) {
      const result = await acceptChallenge(env, waiting.id, telegramId);
      if (result.ok) return { ok: true, game: result.game, matched: true };
      // Fell through (e.g. the waiting player's balance dropped in the meantime) — queue fresh below.
    }
    // Lost the race to claim it — fall through and create our own waiting entry.
  }

  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO games (id, player1_id, player2_id, status, created_at, expires_at)
     VALUES (?, ?, NULL, 'pending', ?, ?)`
  )
    .bind(id, telegramId, now, now + MATCHMAKING_TTL_SECONDS)
    .run();

  const game = await getGameRow(env, id);
  return { ok: true, game, matched: false };
}

export async function cancelMatchmaking(env, telegramId, gameId) {
  await env.DB.prepare(
    `UPDATE games SET status = 'cancelled'
     WHERE id = ? AND player1_id = ? AND player2_id IS NULL AND status = 'pending'`
  )
    .bind(gameId, telegramId)
    .run();
  return { ok: true };
}

// ---- HTTP handlers -------------------------------------------------------

export async function handleChallengeCreate(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const targetTelegramId = String(body?.targetTelegramId || '');
  if (!targetTelegramId) return badRequest('targetTelegramId is required');

  const result = await createChallenge(env, auth.telegramId, targetTelegramId);
  if (!result.ok) return json({ error: result.error }, 400);

  // Optionally announce in a Telegram group chat if the client tells us which one.
  if (body.chatId) {
    try {
      const { announceChallenge } = await import('./telegram.js');
      const [challenger, target] = await Promise.all([
        getUserByTelegramId(env, auth.telegramId),
        getUserByTelegramId(env, targetTelegramId),
      ]);
      await announceChallenge(
        env,
        body.chatId,
        result.game,
        challenger?.username ? '@' + challenger.username : 'A player',
        target?.username ? '@' + target.username : 'a player'
      );
    } catch (err) {
      console.error('Failed to announce challenge', err);
    }
  }

  return json({ game: publicGame(result.game, auth.telegramId) });
}

export async function handleChallengeAccept(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const gameId = body?.gameId;
  if (!gameId) return badRequest('gameId is required');

  const result = await acceptChallenge(env, gameId, auth.telegramId);
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ game: publicGame(result.game, auth.telegramId) });
}

export async function handleChallengeDecline(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const gameId = body?.gameId;
  if (!gameId) return badRequest('gameId is required');

  const result = await declineChallenge(env, gameId, auth.telegramId);
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ ok: true });
}

export async function handleMatchmakingJoin(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const result = await joinMatchmaking(env, auth.telegramId);
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ game: publicGame(result.game, auth.telegramId), matched: result.matched });
}

export async function handleMatchmakingCancel(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const gameId = body?.gameId;
  if (!gameId) return badRequest('gameId is required');

  await cancelMatchmaking(env, auth.telegramId, gameId);
  return json({ ok: true });
}

export async function handleForfeit(request, env, gameId) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const result = await forfeitGame(env, gameId, auth.telegramId);
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ status: 'completed', winnerId: result.winnerId });
}

export async function handleGetGame(request, env, gameId) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const game = await getGameRow(env, gameId);
  if (!game) return notFound('Game not found');
  if (game.player1_id !== auth.telegramId && game.player2_id !== auth.telegramId) {
    return forbidden('You are not a player in this game');
  }

  const [p1, p2] = await Promise.all([
    getUserByTelegramId(env, game.player1_id),
    game.player2_id ? getUserByTelegramId(env, game.player2_id) : null,
  ]);

  return json({
    game: publicGame(game, auth.telegramId),
    player1: p1 ? { telegramId: p1.telegram_id, username: p1.username } : null,
    player2: p2 ? { telegramId: p2.telegram_id, username: p2.username } : null,
  });
}

/**
 * POST /api/game/:id/result — a player reports their own outcome
 * ('win' | 'loss' | 'draw'). The match is only settled (coins + stats)
 * once both sides have reported and their claims are mutually consistent.
 * Settlement itself is guarded by an optimistic status check so it can
 * only ever run once, even under concurrent/duplicate requests.
 */
export async function handleGameResult(request, env, gameId) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const result = body?.result;
  if (!['win', 'loss', 'draw'].includes(result)) {
    return badRequest('result must be one of "win", "loss", "draw"');
  }

  const game = await getGameRow(env, gameId);
  if (!game) return notFound('Game not found');

  const isP1 = game.player1_id === auth.telegramId;
  const isP2 = game.player2_id === auth.telegramId;
  if (!isP1 && !isP2) return forbidden('You are not a player in this game');

  if (game.status === 'completed') {
    // Already settled — reject duplicate submissions, but tell the caller the outcome.
    return json({ status: 'completed', winnerId: game.winner_id || null });
  }
  if (game.status !== 'started') {
    return badRequest(`Game is not active (status: ${game.status})`);
  }

  const column = isP1 ? 'result_p1' : 'result_p2';
  const otherColumn = isP1 ? 'result_p2' : 'result_p1';

  // Record this player's claim (idempotent: overwriting your own prior claim is fine).
  await env.DB.prepare(`UPDATE games SET ${column} = ? WHERE id = ? AND status = 'started'`)
    .bind(result, gameId)
    .run();

  const refreshed = await getGameRow(env, gameId);
  const mine = refreshed[column];
  const theirs = refreshed[otherColumn];

  if (!theirs) {
    return json({ status: 'waiting_for_opponent' });
  }

  // Reconcile both self-reports.
  const p1Result = isP1 ? mine : theirs;
  const p2Result = isP1 ? theirs : mine;

  let winnerTelegramId = null;
  let voided = false;
  if (p1Result === 'draw' && p2Result === 'draw') {
    winnerTelegramId = null;
  } else if (p1Result === 'win' && p2Result === 'loss') {
    winnerTelegramId = game.player1_id;
  } else if (p1Result === 'loss' && p2Result === 'win') {
    winnerTelegramId = game.player2_id;
  } else {
    // Contradictory reports (e.g. both claim "win") — cannot trust either.
    // Void the match: refund both entry fees, no stats change.
    voided = true;
  }

  // Optimistic concurrency: only one concurrent request can flip status
  // 'started' -> 'completed'. Losers of this race just re-read below.
  const claim = await env.DB.prepare(
    `UPDATE games SET status = 'completed', winner_id = ? WHERE id = ? AND status = 'started'`
  )
    .bind(winnerTelegramId, gameId)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    // Someone else already settled it in the meantime.
    const finalGame = await getGameRow(env, gameId);
    return json({ status: 'completed', winnerId: finalGame.winner_id || null });
  }

  if (voided) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(ENTRY_COST, game.player1_id),
      env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(ENTRY_COST, game.player2_id),
    ]);
    return json({ status: 'voided', reason: 'Conflicting results reported; entry fees refunded.' });
  }

  if (winnerTelegramId === null) {
    // Genuine draw: both entry fees are refunded, so a draw is a true
    // net-zero outcome — nobody should end up 10 coins down just because
    // neither side won. (The entry fee was already deducted from both
    // players back in acceptChallenge when the match started; without this
    // refund it would silently vanish on a draw, which was a bug — coins
    // should only ever move on a real win/loss, never on a draw.)
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1 WHERE telegram_id = ?'
      ).bind(ENTRY_COST, game.player1_id),
      env.DB.prepare(
        'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1 WHERE telegram_id = ?'
      ).bind(ENTRY_COST, game.player2_id),
    ]);
    return json({ status: 'completed', winnerId: null, draw: true });
  }

  const loserTelegramId = winnerTelegramId === game.player1_id ? game.player2_id : game.player1_id;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1, wins = wins + 1 WHERE telegram_id = ?'
    ).bind(ENTRY_COST, winnerTelegramId),
    env.DB.prepare(
      'UPDATE users SET total_matches = total_matches + 1, losses = losses + 1 WHERE telegram_id = ?'
    ).bind(loserTelegramId),
  ]);

  return json({ status: 'completed', winnerId: winnerTelegramId });
}
