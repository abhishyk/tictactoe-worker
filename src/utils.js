// Shared helpers used across the Worker.

export const GAME_TTL_SECONDS = 15 * 60; // temporary game rows expire after 15 minutes
export const ENTRY_COST = 10;
export const STARTING_COINS = 100;
export const ONLINE_WINDOW_SECONDS = 5 * 60; // "online" = active in the last 5 minutes
export const MATCHMAKING_TTL_SECONDS = 90; // how long an "Auto Match" queue entry waits before expiring

// "Buy Coins" packages, priced in Telegram Stars (currency code "XTR").
// Stars paid here go straight to the BOT's own Stars balance — there is no
// per-purchase recipient to configure or hide; edit amounts/prices freely.
export const COIN_PACKAGES = [
  { id: 'pack_50', stars: 50, coins: 500, label: '500 Coins' },
  { id: 'pack_100', stars: 100, coins: 1100, label: '1,100 Coins' },
  { id: 'pack_250', stars: 250, coins: 3000, label: '3,000 Coins' },
  { id: 'pack_500', stars: 500, coins: 6500, label: '6,500 Coins' },
];

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function badRequest(message) {
  return json({ error: message }, 400);
}

export function unauthorized(message = 'Unauthorized') {
  return json({ error: message }, 401);
}

export function forbidden(message = 'Forbidden') {
  return json({ error: message }, 403);
}

export function notFound(message = 'Not found') {
  return json({ error: message }, 404);
}

export function serverError(message = 'Internal server error') {
  return json({ error: message }, 500);
}

// Generates a URL-safe random id (used for user ids and game ids/tokens).
export function generateId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Very small fixed-window rate limiter backed by the D1 users/games activity.
// For a lightweight Mini App we avoid a KV/Durable Object dependency and
// instead rate-limit per-request using an in-memory map that resets per
// isolate. This is best-effort (isolates can be recycled) but stops naive
// bursts without adding infrastructure. For strict global rate limiting,
// bind a Cloudflare Rate Limiting rule or KV namespace in wrangler.toml.
const buckets = new Map();

export function rateLimit(key, limit = 20, windowSeconds = 10) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  if (entry.count > limit) return false;
  return true;
}

export function sanitizeUsername(username) {
  if (!username) return null;
  return String(username).slice(0, 64);
}
