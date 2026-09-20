// Telegram integration: initData validation (Mini App auth) + Bot webhook.
import { nowSeconds, sanitizeUsername, COIN_PACKAGES } from './utils.js';
import { getOrCreateUser, getUserByTelegramId, getUserByUsername } from './auth.js';
import { createChallenge, acceptChallenge, declineChallenge } from './games.js';
import { getLeaderboard } from './leaderboard.js';

const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60; // 24h

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(keyMaterial, message, keyIsRaw = false) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    keyIsRaw ? keyMaterial : enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

/**
 * Validates Telegram Mini App initData per:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns the parsed user object on success, or null on failure.
 * NEVER trust initDataUnsafe from the client — this must run server-side.
 */
export async function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckEntries = [];
  for (const [key, value] of params.entries()) {
    dataCheckEntries.push(`${key}=${value}`);
  }
  dataCheckEntries.sort();
  const dataCheckString = dataCheckEntries.join('\n');

  // secret_key = HMAC_SHA256(bot_token, "WebAppData")
  const secretKey = await hmacSha256('WebAppData', botToken);
  const computedHashBuf = await hmacSha256(secretKey, dataCheckString, true);
  const computedHash = bufToHex(computedHashBuf);

  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || nowSeconds() - authDate > INIT_DATA_MAX_AGE_SECONDS) {
    return null; // stale initData, reject
  }

  const userRaw = params.get('user');
  if (!userRaw) return null;

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!user || !user.id) return null;

  return {
    telegramId: String(user.id),
    username: sanitizeUsername(user.username || [user.first_name, user.last_name].filter(Boolean).join(' ')),
    startParam: params.get('start_param') || null,
  };
}

/** Extracts and validates the initData header on every protected request. */
export async function authenticateRequest(request, env) {
  const initData = request.headers.get('X-Telegram-Init-Data');
  if (!initData) return null;
  const parsed = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!parsed) return null;
  return parsed;
}

async function callTelegramApi(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export function sendMessage(env, chatId, text, replyMarkup) {
  return callTelegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

export function editMessageText(env, chatId, messageId, text, replyMarkup) {
  return callTelegramApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

export function answerCallbackQuery(env, callbackQueryId, text) {
  return callTelegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

/**
 * Creates a Telegram Stars invoice link for a coin package. `currency:
 * 'XTR'` is Telegram's own Stars currency — no payment provider/provider
 * token is needed (or possible) for Stars, so `provider_token` is left
 * empty. The Stars a buyer pays land directly in the BOT's own Stars
 * balance (managed from BotFather / Fragment by whoever owns the bot) —
 * there is no separate recipient to name or hide.
 */
export async function createInvoiceLink(env, { title, description, payload, amountStars }) {
  const res = await callTelegramApi(env, 'createInvoiceLink', {
    title,
    description,
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: title, amount: amountStars }],
  });
  if (!res.ok) throw new Error(res.description || 'Failed to create invoice');
  return res.result; // invoice link URL
}

export function answerPreCheckoutQuery(env, preCheckoutQueryId, ok, errorMessage) {
  return callTelegramApi(env, 'answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    error_message: errorMessage,
  });
}

function miniAppUrl(env, startParam) {
  // Reverted: `t.me/<bot>?startapp=` (no app name) only auto-opens a Mini
  // App if Telegram can tell WHICH app to launch, which for a bot created
  // the normal BotFather /newapp way it can't infer — it needs the app's
  // own short name in the path. The named-app form below is the one that
  // actually works for this bot; the earlier "more compatible" swap was a
  // guess that turned out wrong and broke /play instead of fixing anything.
  const base = `https://t.me/${env.TELEGRAM_BOT_USERNAME}/${env.TELEGRAM_MINIAPP_NAME}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}

function playGameKeyboard(env, startParam, label = '🎮 Open Game') {
  return {
    inline_keyboard: [[{ text: label, url: miniAppUrl(env, startParam) }]],
  };
}

/** Main Telegram webhook entry point. Handles both commands and callback queries. */
export async function handleTelegramWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('ok'); // ignore malformed updates
  }

  try {
    if (update.pre_checkout_query) {
      await handlePreCheckoutQuery(update.pre_checkout_query, env);
    } else if (update.message) {
      await handleMessage(update.message, env);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    }
  } catch (err) {
    // Never let a bot-handling error surface a 500 to Telegram (it retries forever).
    console.error('Webhook handling error', err);
  }

  return new Response('ok');
}

/**
 * Opportunistically remembers every group the bot has been used in — no
 * separate `my_chat_member` webhook handling needed. Called once per group
 * message the bot actually processes (i.e. whenever someone uses a command
 * in that group), which is exactly when we already know its chat id/title.
 * Used only by the periodic "nudge" broadcast (see sendGroupNudges below).
 */
async function registerGroup(env, chat) {
  try {
    await env.DB.prepare(
      `INSERT INTO groups (chat_id, title, active, first_seen_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1`
    )
      .bind(String(chat.id), chat.title || chat.username || 'Group', nowSeconds())
      .run();
  } catch (err) {
    console.error('registerGroup failed', err);
  }
}

// Matched in-memory (zero D1 cost) against every plain group message; only
// a MATCH ever touches the database.
const CHAT_TRIGGERS = /\b(tic\s*tac\s*toe|game\s*khel|challenge|coins?|money)\b/i;

// Each reply's button deep-links straight into a Bot match (startapp=playbot
// — see app.js's init()), not just the app's home screen, so tapping it
// drops the player directly into a live game against the bot.
const CHAT_REPLIES = [
  '⚔️ <b>Tic Tac Toe Challenge!</b> ⚔️\n\nTic Tac Toe pe Tic Tac Toe khelna hai? 😏\n<b>Dum hai to mujhe game mein hara ke dikhao!</b>',
  "🏆 <b>I'm challenging YOU!</b> 🏆\n\nBeat me and win a prize! 💰\n\nSoch kya rahe ho? Neeche button dabao aur seedha match shuru karo 👇",
  '😏 <b>Coins ki baat ho rahi hai?</b>\n\nSabse aasan tarika — mujhe (bot ko) hara ke dikhao aur coins jeeto! 🪙\n\n⚔️ Ready ho?',
];

// Avoids replying every time the trigger fires in a busy group — one
// reactive nudge is enough for a few minutes, however many people say it.
const KEYWORD_REPLY_COOLDOWN_SECONDS = 5 * 60;

async function maybeReactToKeyword(env, chat, text) {
  if (!CHAT_TRIGGERS.test(text)) return;

  const chatId = String(chat.id);
  try {
    const row = await env.DB.prepare('SELECT last_keyword_reply_at FROM groups WHERE chat_id = ?')
      .bind(chatId)
      .first();
    const cutoff = nowSeconds() - KEYWORD_REPLY_COOLDOWN_SECONDS;
    if (row && row.last_keyword_reply_at && row.last_keyword_reply_at > cutoff) return; // still cooling down

    await registerGroup(env, chat); // make sure it's tracked even if no command was ever used
    const reply = CHAT_REPLIES[Math.floor(Math.random() * CHAT_REPLIES.length)];
    await sendMessage(env, chatId, reply, playGameKeyboard(env, 'playbot', '⚔️ Beat The Bot'));
    await env.DB.prepare('UPDATE groups SET last_keyword_reply_at = ? WHERE chat_id = ?')
      .bind(nowSeconds(), chatId)
      .run();
  } catch (err) {
    console.error('maybeReactToKeyword failed', err);
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const fromId = String(message.from.id);
  const username = sanitizeUsername(message.from.username || message.from.first_name);
  const isGroup = message.chat.type !== 'private';

  // A successful Telegram Stars payment arrives as a plain message with a
  // `successful_payment` field (no text/command) — handle it before any
  // text-based routing below.
  if (message.successful_payment) {
    await handleSuccessfulPayment(message, env);
    return;
  }

  const text = (message.text || '').trim();

  // NOTE: registerGroup() is only ever called from inside the /command
  // branches below, NOT here for every message. With Group Privacy turned
  // OFF in BotFather, this webhook receives EVERY message in the group (not
  // just commands) — writing to D1 on every single one would defeat the
  // whole point of keeping this cheap. The keyword-reaction path further
  // down only touches D1 when a trigger word actually matches.
  if (isGroup && text.startsWith('/')) {
    await registerGroup(env, message.chat);
  }

  if (text.startsWith('/play')) {
    await sendMessage(
      env,
      chatId,
      '🎮 <b>Tic Tac Toe</b>\n\nChallenge a friend, play the computer, or climb the leaderboard.\n\n💡 In a group: reply to a member\'s message with /challenge, or use /challenge @username directly.',
      playGameKeyboard(env, null, '▶️ Open Game')
    );
    return;
  }

  if (text.startsWith('/challenge')) {
    // Primary path: command sent as a REPLY to the target's message — Telegram
    // normally includes the real user id/username on `reply_to_message.from`
    // even under default group privacy mode, because it's part of the message
    // the command itself is attached to.
    //
    // NOTE: some Telegram accounts have privacy settings that make Telegram
    // send the reply as `external_reply` with `origin.type: "hidden_user"`
    // instead of a proper `reply_to_message` — in that case there is no real
    // user id at all, by Telegram's own design, and no server-side code can
    // recover it. `/challenge @username` below is the fallback for exactly
    // that situation.
    let target = message.reply_to_message?.from;
    let targetUsername;

    if (!target) {
      // Fallback path: /challenge @username — looks the person up in our own
      // D1 `users` table (only works if they've messaged the bot or opened
      // the Mini App at least once, since Telegram never lets a bot resolve
      // an arbitrary @username to an id on its own).
      const mention = text.split(/\s+/)[1];
      if (mention && mention.startsWith('@')) {
        const found = await getUserByUsername(env, mention);
        if (!found) {
          await sendMessage(
            env,
            chatId,
            `⚠️ Couldn't find ${mention}. They need to have opened the bot or the Mini App at least once — or reply to one of their messages with <code>/challenge</code> instead.`
          );
          return;
        }
        targetUsername = found.username;
        target = { id: found.telegram_id, is_bot: false, username: found.username };
      } else {
        await sendMessage(
          env,
          chatId,
          '⚠️ To challenge someone, reply to one of their messages with <code>/challenge</code>, or use <code>/challenge @username</code>.'
        );
        return;
      }
    }
    if (target.is_bot) {
      await sendMessage(env, chatId, "🤖 You can't challenge a bot — try a real group member.");
      return;
    }
    const targetId = String(target.id);
    if (targetId === fromId) {
      await sendMessage(env, chatId, "😅 You can't challenge yourself.");
      return;
    }

    targetUsername = targetUsername || sanitizeUsername(target.username || target.first_name);
    await getOrCreateUser(env, fromId, username);
    await getOrCreateUser(env, targetId, targetUsername);

    const result = await createChallenge(env, fromId, targetId);
    if (!result.ok) {
      await sendMessage(env, chatId, `⚠️ ${result.error}`);
      return;
    }

    await announceChallenge(
      env,
      chatId,
      result.game,
      username ? '@' + username : 'A player',
      targetUsername ? '@' + targetUsername : 'a player'
    );
    return;
  }

  if (text.startsWith('/wallet')) {
    const user = await getOrCreateUser(env, fromId, username);
    // ID + username shown together so it's unambiguous whose wallet this is
    // (useful when comparing with /leaderboard, or sharing your ID for
    // someone to /challenge @username you by). <code> makes it tap-to-copy
    // in Telegram.
    await sendMessage(
      env,
      chatId,
      `💰 <b>Wallet</b>\n\n${username ? '@' + username + ' — ' : ''}ID: <code>${fromId}</code>\n\nCoins: <b>${user.coins}</b>\nMatches: ${user.total_matches}\nWins: ${user.wins}\nLosses: ${user.losses}`
    );
    return;
  }

  if (text.startsWith('/buy')) {
    await sendMessage(
      env,
      chatId,
      '💰 <b>Buy Coins</b>\n\nOpen the Mini App → Wallet → Buy Coins to pay with Telegram Stars.',
      playGameKeyboard(env, null, '👛 Open Wallet')
    );
    return;
  }

  if (text.startsWith('/leaderboard')) {
    const rows = await getLeaderboard(env, 10);
    // ID shown alongside each name so two players who happen to share a
    // display name (or a player with no @username at all) are still
    // distinguishable — and so you have their ID handy to /challenge them.
    const lines = rows.map(
      (r, i) =>
        `${i + 1}. ${r.username ? '@' + r.username : 'Player'} <code>(${r.telegram_id})</code> — ${r.wins} wins`
    );
    await sendMessage(
      env,
      chatId,
      `🏆 <b>Leaderboard</b>\n\n${lines.join('\n') || 'No players yet.'}`
    );
    return;
  }

  // No command matched. This branch only ever runs once Group Privacy is
  // turned OFF in BotFather — with it on (the default), Telegram never
  // forwards a plain, non-command group message to the bot at all, so this
  // is silently a no-op until that setting is changed.
  if (isGroup && text) {
    await maybeReactToKeyword(env, message.chat, text);
  }
}

async function handleCallbackQuery(cbq, env) {
  const data = cbq.data || '';
  const chatId = cbq.message?.chat?.id;
  const messageId = cbq.message?.message_id;
  const fromId = String(cbq.from.id);
  const username = sanitizeUsername(cbq.from.username || cbq.from.first_name);

  await getOrCreateUser(env, fromId, username); // ensure the responder exists

  if (data.startsWith('accept:')) {
    const gameId = data.slice('accept:'.length);
    const result = await acceptChallenge(env, gameId, fromId);
    if (!result.ok) {
      await answerCallbackQuery(env, cbq.id, result.error);
      return;
    }
    const p1 = await getUserByTelegramId(env, result.game.player1_id);
    const p2 = await getUserByTelegramId(env, result.game.player2_id);
    await editMessageText(
      env,
      chatId,
      messageId,
      `🎮 <b>Match Ready!</b>\n\n${p1?.username ? '@' + p1.username : 'Player 1'} vs ${p2?.username ? '@' + p2.username : 'Player 2'}\n\nEntry: 10 coins each`,
      playGameKeyboard(env, gameId, '▶️ PLAY GAME')
    );
    await answerCallbackQuery(env, cbq.id, 'Challenge accepted!');
    return;
  }

  if (data.startsWith('decline:')) {
    const gameId = data.slice('decline:'.length);
    await declineChallenge(env, gameId, fromId);
    await editMessageText(env, chatId, messageId, '❌ Challenge declined.');
    await answerCallbackQuery(env, cbq.id, 'Declined.');
    return;
  }
}

/**
 * Telegram requires an answer within 10 seconds confirming the order is
 * still valid before it will actually charge the buyer. We just re-check
 * the payload names a package that still exists.
 */
async function handlePreCheckoutQuery(pcq, env) {
  const packageId = (pcq.invoice_payload || '').split(':')[1];
  const pkg = COIN_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) {
    await answerPreCheckoutQuery(env, pcq.id, false, 'This coin package is no longer available.');
    return;
  }
  await answerPreCheckoutQuery(env, pcq.id, true);
}

/**
 * The actual payment confirmation. `telegram_payment_charge_id` uniquely
 * identifies this exact payment — we insert it as a primary key before
 * crediting anything, so a retried webhook delivery (Telegram does retry)
 * can never credit the same Stars payment twice.
 */
async function handleSuccessfulPayment(message, env) {
  const payment = message.successful_payment;
  const fromId = String(message.from.id);
  const chatId = message.chat.id;
  const chargeId = payment.telegram_payment_charge_id;
  const packageId = (payment.invoice_payload || '').split(':')[1];
  const pkg = COIN_PACKAGES.find((p) => p.id === packageId);

  if (!pkg) {
    await sendMessage(env, chatId, '⚠️ Payment received but the coin package could not be matched. Please contact support.');
    return;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO payments (charge_id, telegram_id, package_id, stars, coins_credited, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(chargeId, fromId, pkg.id, payment.total_amount, pkg.coins, nowSeconds())
      .run();
  } catch {
    // Primary key conflict = this exact payment was already processed
    // (a Telegram webhook retry) — do not credit coins a second time.
    return;
  }

  await getOrCreateUser(env, fromId, sanitizeUsername(message.from.username || message.from.first_name));
  await env.DB.prepare('UPDATE users SET coins = coins + ? WHERE telegram_id = ?').bind(pkg.coins, fromId).run();

  await sendMessage(env, chatId, `✅ Payment received — <b>+${pkg.coins} coins</b> added to your wallet. Enjoy! 🎮`);
}

/** Sends a group-chat challenge message with Accept/Decline buttons. */
export async function announceChallenge(env, chatId, game, challengerName, targetName) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Accept', callback_data: `accept:${game.id}` },
        { text: '❌ Decline', callback_data: `decline:${game.id}` },
      ],
    ],
  };
  return sendMessage(
    env,
    chatId,
    `🎮 <b>${challengerName}</b> challenged <b>${targetName}</b>\n\nEntry: 10 coins each`,
    keyboard
  );
}

// How often each group gets a nudge — 4x/day means every 6 hours.
const NUDGE_INTERVAL_SECONDS = 6 * 60 * 60;

// A small rotating pool so the group doesn't see the exact same line every
// time — picked randomly on each send.
const NUDGE_MESSAGES = [
  '🎮 Is group ka Tic Tac Toe champion kaun hai? Kisi ko <code>/challenge</code> karke pata karo! 🏆',
  '😏 Bore ho rahe ho? Kisi ke message pe reply karke <code>/challenge</code> bolo — 10 coins ka match ho jaaye!',
  '🔥 10 coins daav par, jeetega kaun? <code>/challenge @username</code> se abhi shuru karo!',
  '🏆 Group ka top player kaun hai? <code>/leaderboard</code> bolke check karo!',
];

/**
 * Called from the existing 5-minute cron (see index.js's `scheduled`
 * handler) — cheap on every tick since it only touches groups whose own
 * `last_nudged_at` is actually due; most ticks find nothing to send.
 */
export async function sendGroupNudges(env) {
  const cutoff = nowSeconds() - NUDGE_INTERVAL_SECONDS;
  const due = await env.DB.prepare(
    `SELECT chat_id FROM groups WHERE active = 1 AND (last_nudged_at IS NULL OR last_nudged_at < ?)`
  )
    .bind(cutoff)
    .all();

  for (const row of due.results || []) {
    const text = NUDGE_MESSAGES[Math.floor(Math.random() * NUDGE_MESSAGES.length)];
    try {
      const res = await sendMessage(env, row.chat_id, text, playGameKeyboard(env, null, '🎮 Open Game'));
      if (res && res.ok === false) {
        // Most likely the bot was removed from the group / can no longer
        // message it — stop trying instead of retrying forever every tick.
        await env.DB.prepare('UPDATE groups SET active = 0 WHERE chat_id = ?').bind(row.chat_id).run();
        continue;
      }
      await env.DB.prepare('UPDATE groups SET last_nudged_at = ? WHERE chat_id = ?')
        .bind(nowSeconds(), row.chat_id)
        .run();
    } catch (err) {
      console.error('sendGroupNudges failed for', row.chat_id, err);
    }
  }
}

export { miniAppUrl, playGameKeyboard };
