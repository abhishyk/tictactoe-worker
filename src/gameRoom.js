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
// Emoji reactions players can send each other mid-match. Fixed whitelist so
// the relay only ever carries a known-safe value, never arbitrary text.
const ALLOWED_REACTIONS = ['👍', '😂', '😮', '🔥', '😢', '👏'];

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.board = Array(9).fill(null);
    this.turn = 'X'; // player1 is always X and always moves first
    this.players = null; // { player1: telegramId, player2: telegramId }
    // Ephemeral only — like the board, this is never persisted anywhere.
    // Just the single most recent reaction; the client tracks the
    // timestamp itself to know whether it's already shown it.
    this.lastReaction = null; // { emoji, from, ts }
  }

  async ensurePlayers(gameId) {
    if (this.players) return;
    const row = await this.env.DB.prepare(
      'SELECT player1_id, player2_id, status FROM games WHERE id = ?'
    )
      .bind(gameId)
      .first();
    if (!row) throw new Error('Game not found');
    this.players = { player1: row.player1_id, player2: row.player2_id };
  }

  jsonState(extra = {}) {
    return new Response(
      JSON.stringify({ board: this.board, turn: this.turn, reaction: this.lastReaction, ...extra }),
      { headers: { 'Content-Type': 'application/json' } }
    );
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
        this.turn = 'X';
        this.lastReaction = null;
        return this.jsonState();
      }

      if (body.action === 'reaction') {
        if (!ALLOWED_REACTIONS.includes(body.emoji)) {
          return this.errorResponse('Unsupported reaction', 400);
        }
        this.lastReaction = { emoji: body.emoji, from: telegramId, ts: Date.now() };
        return this.jsonState();
      }

      const index = body.index;
      if (typeof index !== 'number' || index < 0 || index > 8) {
        return this.errorResponse('Invalid cell index', 400);
      }

      const myMark = telegramId === this.players.player1 ? 'X' : 'O';
      if (this.board[index]) return this.errorResponse('Cell already filled', 409);
      if (this.turn !== myMark) return this.errorResponse('Not your turn', 409);

      this.board[index] = myMark;
      this.turn = myMark === 'X' ? 'O' : 'X';
      return this.jsonState();
    }

    return this.errorResponse('Method not allowed', 405);
  }
}
