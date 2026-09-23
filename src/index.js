// Cloudflare Worker entry point: HTTP router + cron handler.
import { corsPreflight, json, notFound, rateLimit, ENTRY_COST, CORS_HEADERS } from './utils.js';
import { handleAuth } from './auth.js';
import { handleMe, handlePlayers } from './users.js';
import {
  handleChallengeCreate,
  handleChallengeAccept,
  handleChallengeDecline,
  handleMatchmakingJoin,
  handleMatchmakingCancel,
  handleGetGame,
  handleGameResult,
  handleForfeit,
  handleRpsLeave,
} from './games.js';
import { handleLeaderboard } from './leaderboard.js';
import { handleTelegramWebhook, authenticateRequest, sendGroupNudges } from './telegram.js';
import { handleShopPackages, handleShopInvoice } from './shop.js';
import { handleSpinInfo, handleSpin } from './spin.js';
import { handleBotWin } from './botmode.js';
import { handleRpsPlay, handle2048Win } from './games2.js';
import { GameRoom } from './gameRoom.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsPreflight();

    const url = new URL(request.url);
    const path = url.pathname;

    // Best-effort per-IP rate limit on all API traffic.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!rateLimit(`ip:${ip}`, 60, 10)) {
      return json({ error: 'Too many requests, slow down.' }, 429);
    }

    try {
      if (path === '/api/auth' && request.method === 'POST') {
        return await handleAuth(request, env);
      }
      if (path === '/api/me' && request.method === 'GET') {
        return await handleMe(request, env);
      }
      if (path === '/api/players' && request.method === 'GET') {
        return await handlePlayers(request, env);
      }
      if (path === '/api/challenge' && request.method === 'POST') {
        return await handleChallengeCreate(request, env);
      }
      if (path === '/api/challenge/accept' && request.method === 'POST') {
        return await handleChallengeAccept(request, env);
      }
      if (path === '/api/challenge/decline' && request.method === 'POST') {
        return await handleChallengeDecline(request, env);
      }
      if (path === '/api/matchmaking/join' && request.method === 'POST') {
        return await handleMatchmakingJoin(request, env);
      }
      if (path === '/api/matchmaking/cancel' && request.method === 'POST') {
        return await handleMatchmakingCancel(request, env);
      }
      const gameResultMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)\/result$/);
      if (gameResultMatch && request.method === 'POST') {
        return await handleGameResult(request, env, gameResultMatch[1]);
      }
      const gameForfeitMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)\/forfeit$/);
      if (gameForfeitMatch && request.method === 'POST') {
        return await handleForfeit(request, env, gameForfeitMatch[1]);
      }
      const rpsLeaveMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)\/rps-leave$/);
      if (rpsLeaveMatch && request.method === 'POST') {
        return await handleRpsLeave(request, env, rpsLeaveMatch[1]);
      }
      const gameStateMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)\/state$/);
      if (gameStateMatch && (request.method === 'GET' || request.method === 'POST')) {
        return await proxyToGameRoom(request, env, gameStateMatch[1], request.method);
      }
      const gameMoveMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)\/move$/);
      if (gameMoveMatch && request.method === 'POST') {
        return await proxyToGameRoom(request, env, gameMoveMatch[1], 'POST');
      }
      const gameMatch = path.match(/^\/api\/game\/([a-zA-Z0-9_-]+)$/);
      if (gameMatch && request.method === 'GET') {
        return await handleGetGame(request, env, gameMatch[1]);
      }
      if (path === '/api/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(request, env);
      }
      if (path === '/api/shop/packages' && request.method === 'GET') {
        return await handleShopPackages(request, env);
      }
      if (path === '/api/shop/invoice' && request.method === 'POST') {
        return await handleShopInvoice(request, env);
      }
      if (path === '/api/spin' && request.method === 'GET') {
        return await handleSpinInfo(request, env);
      }
      if (path === '/api/spin' && request.method === 'POST') {
        return await handleSpin(request, env);
      }
      if (path === '/api/bot-win' && request.method === 'POST') {
        return await handleBotWin(request, env);
      }
      if (path === '/api/rps/play' && request.method === 'POST') {
        return await handleRpsPlay(request, env);
      }
      if (path === '/api/2048-win' && request.method === 'POST') {
        return await handle2048Win(request, env);
      }
      if (path === '/api/telegram/webhook' && request.method === 'POST') {
        // Optional shared-secret check (set TELEGRAM_WEBHOOK_SECRET and
        // configure the same value via setWebhook's secret_token).
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
          if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
            return new Response('forbidden', { status: 403 });
          }
        }
        return await handleTelegramWebhook(request, env);
      }
      if (path === '/' || path === '/health') {
        return json({ ok: true, service: 'tictactoe-worker' });
      }

      return notFound();
    } catch (err) {
      console.error('Unhandled error', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },

  // Cron Trigger (configured in wrangler.toml) — periodically clears out
  // expired temporary game rows. Permanent user data (the users table) is
  // never touched here. Any game that expired while still 'started' (i.e.
  // one or both players abandoned it before reporting a result) has its
  // entry fees refunded first, so nobody permanently loses coins to a
  // match that was never finished.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredGames(env));
    ctx.waitUntil(sendGroupNudges(env));
  },
};

// Authenticates the caller, confirms they own a seat in the given game and
// that it is actually 'started', then relays the request to that game's
// Durable Object (the only place the live board briefly exists). The
// Worker — not the client — supplies the verified telegramId, so the DO
// never has to trust anything from the browser directly.
async function proxyToGameRoom(request, env, gameId, method) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const game = await env.DB.prepare('SELECT player1_id, player2_id, status FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return json({ error: 'Game not found' }, 404);
  if (game.player1_id !== auth.telegramId && game.player2_id !== auth.telegramId) {
    return json({ error: 'You are not a player in this game' }, 403);
  }
  if (game.status !== 'started') {
    return json({ error: `Game is not active (status: ${game.status})` }, 400);
  }

  const id = env.GAME_ROOM.idFromName(gameId);
  const stub = env.GAME_ROOM.get(id);

  const roomUrl = new URL('https://game-room.internal/');
  roomUrl.searchParams.set('gameId', gameId);
  roomUrl.searchParams.set('telegramId', auth.telegramId);

  const init = { method };
  if (method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = await request.text();
  }

  const roomResponse = await stub.fetch(roomUrl.toString(), init);

  // The Durable Object's own Response has no CORS headers (it doesn't know
  // it's being called cross-origin from the Pages frontend), so the browser
  // silently blocks it once it comes back through here. Re-wrap it with the
  // same CORS headers every other endpoint already gets via json().
  const headers = new Headers(roomResponse.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(roomResponse.body, { status: roomResponse.status, headers });
}

async function cleanupExpiredGames(env) {
  const now = Math.floor(Date.now() / 1000);

  const expiredStarted = await env.DB.prepare(
    `SELECT id, player1_id, player2_id, entry_deducted FROM games WHERE expires_at < ? AND status = 'started'`
  )
    .bind(now)
    .all();

  for (const game of expiredStarted.results || []) {
    // Refund both entry fees, then remove the row. Guard with a status
    // check so a game that gets settled in this same instant isn't double-refunded.
    // If the entry fee was never actually taken (nobody played a single
    // move — see gameRoom.js/chargeEntryFees), there's nothing to refund:
    // this expiry is a true no-fault cancel, not a refund.
    const claim = await env.DB.prepare(
      `UPDATE games SET status = 'expired' WHERE id = ? AND status = 'started'`
    )
      .bind(game.id)
      .run();
    if (claim.meta && claim.meta.changes > 0 && game.entry_deducted) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(
          ENTRY_COST,
          game.player1_id
        ),
        env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(
          ENTRY_COST,
          game.player2_id
        ),
      ]);
    }
  }

  await env.DB.prepare('DELETE FROM games WHERE expires_at < ?').bind(now).run();
}
