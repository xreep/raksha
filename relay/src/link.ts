/**
 * Telegram chat-id linking via an unguessable deep-link token.
 *
 * A bot may only message a chat that opened it first, so the caregiver has to do one thing once:
 * tap a link. The **app** generates a 128-bit random `linkToken` (base64url, 22 chars) and shows
 * the caregiver `https://t.me/<BOT_USERNAME>?start=<linkToken>`. Telegram delivers
 * `/start <linkToken>` to our webhook; we store `link:<linkToken> → chat_id` in KV for ten minutes
 * and reply that the chat is linked. Meanwhile the app polls `POST /link { linkToken }`, which
 * answers 404 until the tap lands and then returns the chat id once (the key is deleted).
 *
 * ## Why a token the app makes, not a code the bot makes
 * A six-digit code the caregiver reads out is 10^6 possibilities in a ten-minute window — a
 * per-IP rate limit does not make that safe against a distributed guesser, and a guessed code
 * hands an attacker a caregiver's chat id to spam. 128 bits from the phone's CSPRNG is not
 * guessable in any window; the only party that ever sees it is the caregiver's Telegram client.
 * Telegram's `start` payload allows `[A-Za-z0-9_-]{1,64}`, which base64url fits exactly.
 *
 * ## One-time, eventually
 * KV is eventually consistent across edge locations (up to ~60 s). The delete on redeem is
 * immediate where it happens; a second `/link` for the same token at another location inside
 * that window can still read the value. The token is worthless after the app has stored the chat
 * id, so the exposure is "the app learns the same chat id twice", not a leak.
 *
 * Nothing about the PHC user crosses this flow — no phone number, no name, no health data.
 *
 * Webhook reference: https://core.telegram.org/bots/api#setwebhook — the `secret_token` given to
 * setWebhook arrives on every update as `X-Telegram-Bot-Api-Secret-Token`.
 */

import { telegramSendMessage } from './adapters/telegram';
import type { SendOptions } from './adapters/types';
import { LINK_TOKEN } from './contract';
import type { Env } from './env';

/** The subset of `KVNamespace` this module uses — a fake in tests, the real binding in prod. */
export interface LinkStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** KV requires a TTL of at least 60 s; ten minutes covers showing a link and tapping it. */
export const LINK_TTL_SECONDS = 600;
const KEY_PREFIX = 'link:';

export function isLinkToken(value: string): boolean {
  return LINK_TOKEN.test(value);
}

export const LINKED_MESSAGE = 'Linked to Raksha. You will receive emergency alerts here.';
export const START_HELP =
  'Open the link from the Raksha app to link this chat. Once linked, this chat receives emergency alerts from the Raksha app.';

/** Build the deep link the app shows the caregiver. */
export function telegramDeepLink(botUsername: string, linkToken: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?start=${linkToken}`;
}

/** Record that `chatId` tapped the link carrying `linkToken`. */
export async function storeLink(store: LinkStore, linkToken: string, chatId: string): Promise<void> {
  await store.put(KEY_PREFIX + linkToken, chatId, { expirationTtl: LINK_TTL_SECONDS });
}

/** Exchange a token for its chat id, consuming it. `null` when not yet tapped, expired or used. */
export async function redeemLink(store: LinkStore, linkToken: string): Promise<string | null> {
  const key = KEY_PREFIX + linkToken;
  const chatId = await store.get(key);
  if (chatId === null) return null;
  await store.delete(key);
  return chatId;
}

// ---- webhook ----

/** The parts of a Telegram `Update` this relay looks at. Everything else is ignored. */
export interface TelegramUpdate {
  readonly message?: {
    readonly text?: string;
    readonly chat?: { readonly id?: number | string; readonly type?: string };
  };
}

export type WebhookOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'help'; readonly chatId: string }
  | { readonly kind: 'linked'; readonly chatId: string; readonly linkToken: string };

/**
 * Handle one update. Returns what happened so the router can answer 200 and tests can assert on it
 * without parsing bot replies. Replies use the bot's own sendMessage; a failed reply is swallowed
 * (Telegram would otherwise retry the update).
 */
export async function handleTelegramUpdate(
  update: unknown,
  env: Env,
  store: LinkStore,
  options: SendOptions = {},
): Promise<WebhookOutcome> {
  const message = isUpdate(update) ? update.message : undefined;
  const chatIdRaw = message?.chat?.id;
  const chatId = typeof chatIdRaw === 'number' || typeof chatIdRaw === 'string' ? String(chatIdRaw) : undefined;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (chatId === undefined || text.length === 0) return { kind: 'ignored' };

  const token = env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token.length === 0) return { kind: 'ignored' };
  const sendOptions: SendOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  // `/start <payload>` — the deep link. A bare `/start`, a malformed payload or any other text
  // gets the help line; nothing is stored for those.
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
  const payload = start?.[1];
  if (start !== null && payload !== undefined && isLinkToken(payload)) {
    await storeLink(store, payload, chatId);
    await telegramSendMessage(token, chatId, LINKED_MESSAGE, sendOptions);
    return { kind: 'linked', chatId, linkToken: payload };
  }

  await telegramSendMessage(token, chatId, START_HELP, sendOptions);
  return { kind: 'help', chatId };
}

function isUpdate(value: unknown): value is TelegramUpdate {
  return typeof value === 'object' && value !== null;
}
