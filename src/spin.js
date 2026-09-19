// Spin Wheel: a high-roller bonus once a player's balance reaches 100,000
// coins. Cost is a FLAT 99,000 coins (not "whatever they have minus 1,000")
// — so someone sitting at exactly 100,000 ends up with 1,000 after
// spinning, matching the spec. That flat deduction is also what naturally
// limits spins: the very next one needs 100,000 again, which takes real
// play to reach — no separate "already spun" flag needed.
//
// The reward is picked SERVER-SIDE only. The client never sends or
// influences which segment wins — it just plays an animation that lands on
// whatever this endpoint returns, exactly like PvP moves are authoritative
// on the server, never the browser.
//
// IMPORTANT — what "automatic" means here: this Worker can credit in-game
// coins instantly (that's our own currency, just a D1 UPDATE), but it
// CANNOT itself hand out real Telegram Stars or grant Telegram Premium —
// those require Telegram's paid Gifts/Stars APIs, funded from the bot's
// own Stars balance, which should never fire unattended off a random spin.
// So for every non-coin prize (Stars, Premium, Admin Choice), this endpoint
// only RECORDS the win and messages both the player and the admin —
// actually sending the Stars/Premium/whatever "Admin Choice" turns out to
// be is a manual step you do from Telegram once you see that message.
import { authenticateRequest, sendMessage } from './telegram.js';
import { getUserByTelegramId } from './auth.js';
import { json, unauthorized, badRequest, generateId, nowSeconds } from './utils.js';

export const SPIN_MIN_BALANCE = 100000;
export const SPIN_COST = 99000;

// Order here is also the order the wheel is drawn in on the frontend (the
// client always asks this endpoint for the list rather than hard-coding
// its own copy, so the two can never drift out of sync). Weight is just a
// relative odds number — they don't need to add up to 100 or any fixed
// total.
const SPIN_REWARDS = [
  { reward: '3 Months Premium', weight: 4 },
  { reward: '15 Stars', weight: 25 },
  { reward: '25 Stars', weight: 20 },
  { reward: '50 Stars', weight: 12 },
  { reward: '100 Stars', weight: 6 },
  { reward: 'Better luck next time', weight: 30 },
  { reward: 'Admin Choice', weight: 3 },
];

function pickReward() {
  const total = SPIN_REWARDS.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of SPIN_REWARDS) {
    if (roll < r.weight) return r.reward;
    roll -= r.weight;
  }
  return SPIN_REWARDS[0].reward;
}

const SEGMENT_LABELS = SPIN_REWARDS.map((r) => r.reward);

/** GET /api/spin — eligibility + the wheel's segment order, no side effects. */
export async function handleSpinInfo(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const user = await getUserByTelegramId(env, auth.telegramId);
  if (!user) return badRequest('User not found');

  return json({
    coins: user.coins,
    canSpin: user.coins >= SPIN_MIN_BALANCE,
    minBalance: SPIN_MIN_BALANCE,
    cost: SPIN_COST,
    segments: SEGMENT_LABELS,
  });
}

/** POST /api/spin — the actual spin: charges the coins, picks the reward. */
export async function handleSpin(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const user = await getUserByTelegramId(env, auth.telegramId);
  if (!user) return badRequest('User not found');
  if (user.coins < SPIN_MIN_BALANCE) {
    return badRequest(`You need at least ${SPIN_MIN_BALANCE.toLocaleString()} coins to spin.`);
  }

  // Atomic, race-proof deduction — exactly like the PvP entry fee: the WHERE
  // clause re-checks the balance in the same statement, so two rapid taps
  // (or a retried request on a flaky connection) can never both succeed.
  const claim = await env.DB.prepare(
    'UPDATE users SET coins = coins - ? WHERE telegram_id = ? AND coins >= ?'
  )
    .bind(SPIN_COST, auth.telegramId, SPIN_MIN_BALANCE)
    .run();
  if (!claim.meta || claim.meta.changes === 0) {
    return badRequest('Spin unavailable — your balance changed, please try again.');
  }

  const reward = pickReward();
  const updated = await getUserByTelegramId(env, auth.telegramId);

  await env.DB.prepare(
    `INSERT INTO spin_rewards (id, telegram_id, username, reward, created_at, fulfilled)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(generateId(), auth.telegramId, user.username, reward, nowSeconds(), reward === 'Better luck next time' ? 1 : 0)
    .run();

  if (reward !== 'Better luck next time') {
    const who = user.username ? '@' + user.username : `ID ${auth.telegramId}`;
    // Must be awaited — Cloudflare can tear the isolate down right after the
    // response is sent, so a "fire and forget" call here can get cut off
    // mid-flight before Telegram ever receives it (this is exactly what was
    // silently dropping these messages). Every other bot message in this
    // codebase awaits sendMessage() for the same reason; this endpoint
    // should too.
    if (env.ADMIN_TELEGRAM_ID) {
      try {
        const res = await sendMessage(
          env,
          env.ADMIN_TELEGRAM_ID,
          `🎡 Spin Wheel win!\n\n${who} (<code>${auth.telegramId}</code>) won: <b>${reward}</b>\n\nFulfil it manually, then mark the spin_rewards row as fulfilled in D1.`
        );
        if (!res || res.ok === false) console.error('Spin admin notify failed', res);
      } catch (err) {
        // Don't let a failed admin notification block the player's own
        // message or the response — the win is already safely in D1.
        console.error('Spin admin notify threw', err);
      }
    } else {
      console.error('Spin admin notify skipped — ADMIN_TELEGRAM_ID is not set');
    }
    try {
      const res = await sendMessage(
        env,
        auth.telegramId,
        `🎉 You won <b>${reward}</b> on the Spin Wheel!\n\nOur team will credit this to you shortly.`
      );
      if (!res || res.ok === false) console.error('Spin player notify failed', res);
    } catch (err) {
      console.error('Spin player notify threw', err);
    }
  }

  return json({ reward, coins: updated.coins, segments: SEGMENT_LABELS });
}
