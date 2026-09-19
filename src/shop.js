// "Buy Coins" — Telegram Stars purchases. The Mini App opens a Stars
// invoice created here via Telegram's own payment system; coins are only
// ever credited once Telegram confirms a real payment (see telegram.js's
// handleSuccessfulPayment) — never from anything the frontend claims.
import { authenticateRequest, createInvoiceLink } from './telegram.js';
import { generateId, json, badRequest, unauthorized, COIN_PACKAGES } from './utils.js';

/** GET /api/shop/packages — the coin packages available to buy. */
export async function handleShopPackages(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  return json({
    packages: COIN_PACKAGES.map((p) => ({ id: p.id, stars: p.stars, coins: p.coins, label: p.label })),
  });
}

/** POST /api/shop/invoice — creates a Telegram Stars invoice link for one package. */
export async function handleShopInvoice(request, env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const pkg = COIN_PACKAGES.find((p) => p.id === body?.packageId);
  if (!pkg) return badRequest('Unknown package');

  // The payload only needs to identify the package + be unique per invoice —
  // WHO is paying is never taken from this payload; it comes from Telegram's
  // own `message.from.id` on the successful_payment update, which can't be
  // spoofed by the client.
  const payload = `coins:${pkg.id}:${generateId(6)}`;

  const invoiceLink = await createInvoiceLink(env, {
    title: pkg.label,
    description: `${pkg.stars} Telegram Stars → ${pkg.coins} coins in Tic Tac Toe`,
    payload,
    amountStars: pkg.stars,
  });

  return json({ invoiceLink });
}
