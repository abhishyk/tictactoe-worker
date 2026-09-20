// Durable Object: a purely in-memory, transient relay for the LIVE board of
// one active PvP match.
//
// Why this exists: the spec (correctly) forbids ever storing the board or
// individual moves in D1 — but two different phones still need to see each
// other's taps in real time for PvP to be playable at all. This object
// holds that live position ONLY in memory (nothing is ever written to
// `state.storage`, disk, or D1), so it is functionally no different from
// "the board lives in the browser" — it is simply a relay point between two
// browsers, not a database. If the object is ever evicted mid-match, the
// live position is lost and the match can be retried; this can never cause
// a double coin payout because coin/stat settlement is handled exclusively
// by the D1-backed, idempotent /api/game/:id/result endpoint in games.js,
// which does not depend on this object at all.
import { ENTRY_COST } from './utils.js';

// Emoji reactions players can send each other mid-match. Fixed whitelist so
// the relay only ever carries a known-safe value, never arbitrary text.
const ALLOWED_REACTIONS = ['👍', '😂', '😮', '🔥', '😢', '👏', '❤️', '🎉', '💯', '😱'];

// How long the player ON TURN can sit idle before the WAITING player is
// allowed to end the match themselves (see claimTimeout()).
const INACTIVITY_TIMEOUT_MS = 60 * 1000;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.board = Array(9).fill(null);
    // Who moves first is random each match (X always moves first, but which
    // *player* is X is a coin flip) — previously the challenger (player1)
    // was hard-coded as X, so the same person always got the first move.
    this.turn = Math.random() < 0.5 ? 'X' : 'O';
    this.players = null; // { player1: telegramId, player2: telegramId }
    // Whether the 10-coin entry fee has actually been taken from both
    // players yet. This now happens on the FIRST real move of the match
    // (not at accept time) — see chargeEntryFees() — so a challenge that's
    // accepted but never played never costs either side a coin.
    this.entryDeducted = false;
    // Ephemeral only — like the board, this is never persisted anywhere.
    // Just the single most recent reaction; the client tracks the
    // timestamp itself to know whether it's already shown it.
    this.lastReaction = null; // { emoji, from, ts }
    // When the CURRENT turn began — resets every time a move is made (or
    // the room is reset for a rematch). Used only to let the waiting player
    // claim a timeout after INACTIVITY_TIMEOUT_MS of no response; if this DO
    // instance gets evicted and reloaded mid-match, this simply restarts the
    // clock (a harmless, rare edge case — same tradeoff as the board itself
    // being lost on eviction).
    this.turnStartedAt = Date.now();
    // Total moves made so far. moveCount >= 2 means BOTH players have made
    // at least one real move each (turns strictly alternate) — that's the
    // line between "opponent never showed up at all" (no-fault, refund
    // only) and "opponent was genuinely playing, then vanished mid-match"
    // (treated as a real forfeit: the vanished player loses).
    this.moveCount = 0;
  }

  async ensurePlayers(gameId) {
    if (this.players) return;
    const row = await this.env.DB.prepare(
      'SELECT player1_id, player2_id, status, entry_deducted FROM games WHERE id = ?'
    )
      .bind(gameId)
      .first();
    if (!row) throw new Error('Game not found');
    this.players = { player1: row.player1_id, player2: row.player2_id };
    this.entryDeducted = row.entry_deducted === 1;
  }

  /**
   * Called exactly once per match, right before the FIRST cell is filled.
   * Deducts the 10-coin entry fee from both players atomically (guarded so
   * a rapid double-tap can't double-charge), and persists the flag on the
   * `games` row so a Durable Object restart (which loses the in-memory
   * board) never re-charges an already-charged match.
   */
  async chargeEntryFees(gameId) {
    const claim = await this.env.DB.prepare(
      `UPDATE games SET entry_deducted = 1 WHERE id = ? AND entry_deducted = 0`
    )
      .bind(gameId)
      .run();
    if (!claim.meta || claim.meta.changes === 0) {
      // Someone else's request already charged it a moment ago.
      this.entryDeducted = true;
      return { ok: true };
    }

    const [p1, p2] = await Promise.all([
      this.env.DB.prepare('SELECT coins FROM users WHERE telegram_id = ?').bind(this.players.player1).first(),
      this.env.DB.prepare('SELECT coins FROM users WHERE telegram_id = ?').bind(this.players.player2).first(),
    ]);

    if (!p1 || !p2 || p1.coins < ENTRY_COST || p2.coins < ENTRY_COST) {
      // Nobody actually got charged — undo the flag so the match stays in
      // its pre-move state and can still be forfeited/expired as a
      // no-fault cancel.
      await this.env.DB.prepare('UPDATE games SET entry_deducted = 0 WHERE id = ?').bind(gameId).run();
      return { ok: false, error: "Match can't start — a player no longer has enough coins." };
    }

    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE users SET coins = coins - ? WHERE telegram_id = ? AND coins >= ?').bind(
        ENTRY_COST,
        this.players.player1,
        ENTRY_COST
      ),
      this.env.DB.prepare('UPDATE users SET coins = coins - ? WHERE telegram_id = ? AND coins >= ?').bind(
        ENTRY_COST,
        this.players.player2,
        ENTRY_COST
      ),
    ]);

    this.entryDeducted = true;
    return { ok: true };
  }

  jsonState(extra = {}) {
    return new Response(
      JSON.stringify({
        board: this.board,
        turn: this.turn,
        reaction: this.lastReaction,
        turnStartedAt: this.turnStartedAt,
        moveCount: this.moveCount,
        timeoutMs: INACTIVITY_TIMEOUT_MS,
        ...extra,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * The WAITING player (not on turn) calls this once the opponent has been
   * sitting on their turn for INACTIVITY_TIMEOUT_MS. Two outcomes:
   *  - Opponent had NEVER moved even once in this match (moveCount < 2) →
   *    no-fault cancel: refund whatever was actually deducted, no win/loss.
   *  - Opponent HAD moved before (moveCount >= 2, i.e. both sides had
   *    engaged) and then went idle mid-match → treated exactly like a
   *    forfeit: the caller wins their stake back, the idle player loses.
   */
  async claimTimeout(gameId, telegramId) {
    const isP1 = telegramId === this.players.player1;
    const myMark = isP1 ? 'X' : 'O';
    if (this.turn === myMark) {
      return { ok: false, error: "It's your turn — you can't claim a timeout." };
    }

    const elapsed = Date.now() - this.turnStartedAt;
    if (elapsed < INACTIVITY_TIMEOUT_MS) {
      const waitMore = Math.ceil((INACTIVITY_TIMEOUT_MS - elapsed) / 1000);
      return { ok: false, error: `Please wait ${waitMore}s more before leaving.` };
    }

    const opponentId = isP1 ? this.players.player2 : this.players.player1;

    if (this.moveCount < 2) {
      const claim = await this.env.DB.prepare(
        `UPDATE games SET status = 'cancelled' WHERE id = ? AND status = 'started'`
      )
        .bind(gameId)
        .run();
      if (!claim.meta || claim.meta.changes === 0) {
        return { ok: false, error: 'Match already ended.' };
      }
      if (this.entryDeducted) {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(
            ENTRY_COST,
            this.players.player1
          ),
          this.env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(
            ENTRY_COST,
            this.players.player2
          ),
        ]);
      }
      return { ok: true, outcome: 'cancelled' };
    }

    const claim = await this.env.DB.prepare(
      `UPDATE games SET status = 'completed', winner_id = ? WHERE id = ? AND status = 'started'`
    )
      .bind(telegramId, gameId)
      .run();
    if (!claim.meta || claim.meta.changes === 0) {
      return { ok: false, error: 'Match already ended.' };
    }

    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1, wins = wins + 1 WHERE telegram_id = ?'
      ).bind(ENTRY_COST, telegramId),
      this.env.DB.prepare(
        'UPDATE users SET total_matches = total_matches + 1, losses = losses + 1 WHERE telegram_id = ?'
      ).bind(opponentId),
    ]);

    return { ok: true, outcome: 'won', winnerId: telegramId };
  }

  errorResponse(message, status) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const gameId = url.searchParams.get('gameId');
    const telegramId = url.searchParams.get('telegramId');
    if (!gameId || !telegramId) return this.errorResponse('Missing gameId/telegramId', 400);

    try {
      await this.ensurePlayers(gameId);
    } catch (err) {
      return this.errorResponse(err.message, 404);
    }

    if (telegramId !== this.players.player1 && telegramId !== this.players.player2) {
      return this.errorResponse('Not a player in this game', 403);
    }

    if (request.method === 'GET') {
      return this.jsonState();
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return this.errorResponse('Invalid JSON body', 400);
      }

      if (body.action === 'reset') {
        this.board = Array(9).fill(null);
        this.turn = Math.random() < 0.5 ? 'X' : 'O'; // re-randomize on rematch too
        this.lastReaction = null;
        this.turnStartedAt = Date.now();
        this.moveCount = 0;
        return this.jsonState();
      }

      if (body.action === 'reaction') {
        if (!ALLOWED_REACTIONS.includes(body.emoji)) {
          return this.errorResponse('Unsupported reaction', 400);
        }
        this.lastReaction = { emoji: body.emoji, from: telegramId, ts: Date.now() };
        return this.jsonState();
      }

      if (body.action === 'claim-timeout') {
        const result = await this.claimTimeout(gameId, telegramId);
        if (!result.ok) return this.errorResponse(result.error, 400);
        return this.jsonState({ ended: true, outcome: result.outcome, winnerId: result.winnerId || null });
      }

      const index = body.index;
      if (typeof index !== 'number' || index < 0 || index > 8) {
        return this.errorResponse('Invalid cell index', 400);
      }

      const myMark = telegramId === this.players.player1 ? 'X' : 'O';
      if (this.board[index]) return this.errorResponse('Cell already filled', 409);
      if (this.turn !== myMark) return this.errorResponse('Not your turn', 409);

      if (!this.entryDeducted) {
        const charge = await this.chargeEntryFees(gameId);
        if (!charge.ok) return this.errorResponse(charge.error, 402);
      }

      this.board[index] = myMark;
      this.turn = myMark === 'X' ? 'O' : 'X';
      this.moveCount += 1;
      this.turnStartedAt = Date.now();
      return this.jsonState();
    }

    return this.errorResponse('Method not allowed', 405);
  }
}
