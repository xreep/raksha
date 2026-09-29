import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEGRAM_API_BASE } from '../src/adapters/telegram';
import { TEXTBELT_URL } from '../src/adapters/textbelt';
import { MAX_BODY_BYTES } from '../src/contract';
import { SKIPPED_ERROR } from '../src/dispatch';
import type { Env } from '../src/env';
import worker, { APP_KEY_HEADER, createHandler, safeEqual, TELEGRAM_SECRET_HEADER } from '../src/index';
import { RateLimiter } from '../src/ratelimit';
import { CHAT_ID, FAKE, fullEnv, LINK_TOKEN_A, makeEnv, MESSAGE, PHONE } from './helpers/env';
import { FakeKV } from './helpers/fake-kv';
import { type CapturedCall, stubFetch, stubFetchJson } from './helpers/fetch';

const BASE = 'https://relay.test';

/** POST with the app key already attached (the common case). Pass `null` to omit a header. */
function post(path: string, body: unknown, headers: Record<string, string | null> = {}): Request {
  const merged: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.7',
    [APP_KEY_HEADER]: FAKE.appKey,
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return new Request(BASE + path, { method: 'POST', headers: merged, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** Telegram + free Textbelt, no paid channel → the app key is optional. */
function freeEnv(overrides: Partial<Env> = {}, kv?: FakeKV): Env {
  return makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken, ...overrides }, kv);
}

/** Every adapter configured, app key set — a fully locked-down paid deployment. */
function paidEnv(overrides: Partial<Env> = {}, kv?: FakeKV): Env {
  return fullEnv({ RELAY_APP_KEY: FAKE.appKey, TELEGRAM_WEBHOOK_SECRET: FAKE.webhookSecret, ...overrides }, kv);
}

/** Provider-aware fetch stub: Telegram and Textbelt both succeed unless told otherwise. */
function stubProviders(overrides: { telegram?: Response; textbelt?: Response } = {}) {
  return stubFetch((call: CapturedCall) => {
    if (call.url.startsWith(TELEGRAM_API_BASE)) return overrides.telegram ?? Response.json({ ok: true });
    if (call.url === TEXTBELT_URL) return overrides.textbelt ?? Response.json({ success: true, quotaRemaining: 0 });
    return new Response('unexpected upstream', { status: 599 });
  });
}

// Re-created per test: vitest's `restoreMocks` restores spies after each test.
let consoleSpies: Record<'log' | 'error' | 'warn', ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  consoleSpies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
});

afterEach(() => {
  // No handler path may log payload contents. The 500 path logs an error *name* only (tested below).
  for (const spy of Object.values(consoleSpies)) {
    for (const call of spy.mock.calls) {
      const text = call.map(String).join(' ');
      expect(text).not.toContain(MESSAGE);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(CHAT_ID);
      expect(text).not.toContain(LINK_TOKEN_A);
    }
  }
});

describe('GET /health', () => {
  it('reports configuration, including what is missing, without secrets', async () => {
    const handler = createHandler();
    const response = await handler(new Request(`${BASE}/health`), fullEnv({ SMS_ALWAYS: 'false', BOT_USERNAME: '@phc_bot' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      service: 'phc-sos-relay',
      channels: { telegram: true, textbelt: true, twilio: true, fcm: false },
      channelOrder: ['telegram', 'textbelt'],
      smsAlways: false,
      appKeyRequired: true, // paid channels configured…
      appKeySet: false, // …but no key: /sos will answer 503
      webhookSecured: false,
      linking: true,
      botUsername: 'phc_bot',
    });
    expect(JSON.stringify(body)).not.toContain(FAKE.telegramToken);
  });

  it('shows a free deployment as not needing the key, and a locked-down one as secured', async () => {
    const handler = createHandler();
    const free = await (await handler(new Request(`${BASE}/health`), freeEnv())).json();
    expect(free).toMatchObject({ appKeyRequired: false, appKeySet: false, webhookSecured: false, botUsername: null });
    const paid = await (await handler(new Request(`${BASE}/health`), paidEnv())).json();
    expect(paid).toMatchObject({ appKeyRequired: true, appKeySet: true, webhookSecured: true });
  });

  it('rejects other methods', async () => {
    const response = await createHandler()(new Request(`${BASE}/health`, { method: 'POST' }), makeEnv());
    expect(response.status).toBe(405);
  });
});

describe('POST /sos', () => {
  it('legacy body { to: "<phone>", message } → 200 via the SMS adapter (telegram skipped)', async () => {
    const stub = stubProviders();
    const response = await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }), paidEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.form?.get('message')).toBe(MESSAGE);
  });

  it('structured body → telegram and one SMS concurrently (SMS_ALWAYS), 200', async () => {
    const stub = stubProviders();
    const response = await createHandler()(
      post('/sos', { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE, channels: ['telegram', 'textbelt'] }),
      paidEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(stub.calls.map((c) => c.url).sort()).toEqual([TEXTBELT_URL, `${TELEGRAM_API_BASE}/bot${FAKE.telegramToken}/sendMessage`].sort());
  });

  it('502 with per-channel errors when nothing gets through', async () => {
    stubProviders({
      telegram: Response.json({ ok: false, description: 'chat not found' }, { status: 400 }),
      textbelt: Response.json({ success: false, error: 'Out of quota', quotaRemaining: 0 }),
    });
    const response = await createHandler()(post('/sos', { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE }), paidEnv());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      delivered: false,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram 400: chat not found' },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota (quotaRemaining: 0)' },
      ],
    });
  });

  it('502 on a deployment with no configured channel in the order', async () => {
    const stub = stubProviders();
    const response = await createHandler()(post('/sos', { to: { telegramChatId: CHAT_ID }, message: MESSAGE }), makeEnv({ CHANNEL_ORDER: 'telegram' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ delivered: false, results: [{ channel: 'telegram', ok: false, error: 'not configured' }] });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('planned channels that did not run are reported as skipped, never dropped', async () => {
    stubProviders();
    const response = await createHandler()(
      post('/sos', { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE }),
      freeEnv({ SMS_ALWAYS: 'false' }),
    );
    expect(await response.json()).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: false, error: SKIPPED_ERROR },
      ],
    });
  });

  it('400 on invalid JSON and on an invalid body', async () => {
    const stub = stubProviders();
    const handler = createHandler();
    const bad = await handler(post('/sos', '{not json'), paidEnv());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'body must be JSON' });

    const invalid = await handler(post('/sos', { to: '12345', message: MESSAGE }), paidEnv());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'to must be an E.164 phone number' });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('413 when the body is larger than the cap, before parsing', async () => {
    const stub = stubProviders();
    const handler = createHandler();
    const declared = await handler(post('/sos', { to: PHONE, message: MESSAGE }, { 'Content-Length': String(MAX_BODY_BYTES + 1) }), paidEnv());
    expect(declared.status).toBe(413);
    // Undeclared length (chunked): the cap is enforced on the bytes actually read — bytes, not
    // characters, so a multibyte body that is under the cap in UTF-16 units is still refused.
    const oversized = await handler(post('/sos', { to: PHONE, message: 'x'.repeat(MAX_BODY_BYTES + 100) }, { 'Content-Length': null }), paidEnv());
    expect(oversized.status).toBe(413);
    const multibyte = '€'.repeat(6_000); // 6 000 chars, 18 000 bytes
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(MAX_BODY_BYTES);
    const wide = await handler(post('/sos', { to: PHONE, message: multibyte }, { 'Content-Length': null }), paidEnv());
    expect(wide.status).toBe(413);
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('405 for GET', async () => {
    const response = await createHandler()(new Request(`${BASE}/sos`), paidEnv());
    expect(response.status).toBe(405);
  });

  describe('app key', () => {
    it('401 when RELAY_APP_KEY is set and the header is missing or wrong; passes when it matches', async () => {
      stubProviders();
      const handler = createHandler();
      const env = freeEnv({ RELAY_APP_KEY: FAKE.appKey });

      expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { [APP_KEY_HEADER]: null }), env)).status).toBe(401);
      expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { [APP_KEY_HEADER]: 'nope' }), env)).status).toBe(401);
      expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    });

    it('no check on a free deployment (Telegram + free Textbelt) without a key', async () => {
      stubProviders();
      expect((await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }, { [APP_KEY_HEADER]: null }), freeEnv())).status).toBe(200);
    });

    it.each([
      ['Twilio', { TWILIO_ACCOUNT_SID: FAKE.twilioSid, TWILIO_AUTH_TOKEN: FAKE.twilioToken, TWILIO_FROM: FAKE.twilioFrom }],
      ['a paid Textbelt key', { TEXTBELT_KEY: FAKE.textbeltKey }],
    ])('503 and no upstream call when %s is configured but RELAY_APP_KEY is not', async (_label, paid) => {
      const stub = stubProviders();
      const response = await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }), freeEnv(paid));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'RELAY_APP_KEY required when a paid SMS channel is configured' });
      expect(stub.mock).not.toHaveBeenCalled();
    });

    it('a paid deployment with the key set works with the header', async () => {
      stubProviders();
      expect((await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }), paidEnv())).status).toBe(200);
    });
  });

  it('429 once the per-IP bucket is empty; other IPs unaffected', async () => {
    stubProviders();
    const handler = createHandler({ limiter: new RateLimiter({ limit: 2, windowMs: 60_000 }) });
    const env = paidEnv();
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    const limited = await handler(post('/sos', { to: PHONE, message: MESSAGE }), env);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate limited' });
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { 'CF-Connecting-IP': '198.51.100.2' }), env)).status).toBe(200);
  });

  it('reads RATE_LIMIT_PER_MINUTE from env for the default limiter', async () => {
    stubProviders();
    const handler = createHandler();
    const env = paidEnv({ RATE_LIMIT_PER_MINUTE: '1' });
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(429);
  });

  it('500 without leaking the payload when something throws', async () => {
    const inert = (name: 'textbelt' | 'twilio' | 'fcm', kind: 'sms' | 'data') => ({
      name, kind, notConfiguredError: 'x', notApplicableError: 'y', configured: () => false, applicable: () => true, send: async () => ({ ok: true as const }),
    });
    const handler = createHandler({
      adapters: {
        telegram: { name: 'telegram', kind: 'data', notConfiguredError: 'x', notApplicableError: 'y', configured: () => true, applicable: () => true, send: () => { throw new Error(`boom ${MESSAGE}`); } },
        textbelt: inert('textbelt', 'sms'),
        twilio: inert('twilio', 'sms'),
        fcm: inert('fcm', 'data'),
      },
    });
    const response = await handler(post('/sos', { to: { telegramChatId: CHAT_ID }, message: MESSAGE }), makeEnv({ CHANNEL_ORDER: 'telegram' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
    expect(consoleSpies.error).toHaveBeenCalledWith('relay: unhandled error', 'Error');
  });
});

describe('POST /link', () => {
  it('404 until the caregiver taps, then the chat id once, then 404 again', async () => {
    const kv = new FakeKV();
    const handler = createHandler();
    const env = freeEnv({}, kv);

    const early = await handler(post('/link', { linkToken: LINK_TOKEN_A }), env);
    expect(early.status).toBe(404);
    expect(await early.json()).toEqual({ error: 'not linked yet, expired or already used' });

    await kv.put(`link:${LINK_TOKEN_A}`, CHAT_ID, { expirationTtl: 600 });
    const linked = await handler(post('/link', { linkToken: LINK_TOKEN_A }), env);
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ telegramChatId: CHAT_ID });

    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), env)).status).toBe(404);
    expect(kv.size).toBe(0);
  });

  it('400 on a malformed token (including the old six-digit shape)', async () => {
    const handler = createHandler();
    expect((await handler(post('/link', { code: '123456' }), freeEnv())).status).toBe(400);
    expect((await handler(post('/link', { linkToken: '123456' }), freeEnv())).status).toBe(400);
  });

  it('401 behind the app key, 503 on an unkeyed paid deployment, 429 when rate limited', async () => {
    const handler = createHandler({ limiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }, { [APP_KEY_HEADER]: 'nope' }), paidEnv())).status).toBe(401);
    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), fullEnv())).status).toBe(503);
    // The gate runs before validation, so this 404 spends the only token…
    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), freeEnv())).status).toBe(404);
    // …and the next call from the same IP is limited.
    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), freeEnv())).status).toBe(429);
  });
});

describe('POST /telegram/webhook', () => {
  const update = { update_id: 1, message: { message_id: 1, text: `/start ${LINK_TOKEN_A}`, chat: { id: Number(CHAT_ID), type: 'private' } } };
  const signed = { [TELEGRAM_SECRET_HEADER]: FAKE.webhookSecret };

  it('503 when no webhook secret is configured — never fails open', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const handler = createHandler();
    const response = await handler(post('/telegram/webhook', update, signed), freeEnv({}, kv));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'webhook secret not configured' });
    // Also with no bot token at all: nothing is ever stored or sent.
    expect((await handler(post('/telegram/webhook', update, signed), makeEnv({}, kv))).status).toBe(503);
    expect(kv.size).toBe(0);
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('401 when the secret header is missing or wrong; links when it matches', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const handler = createHandler();
    const env = freeEnv({ TELEGRAM_WEBHOOK_SECRET: FAKE.webhookSecret }, kv);

    expect((await handler(post('/telegram/webhook', update), env)).status).toBe(401);
    expect((await handler(post('/telegram/webhook', update, { [TELEGRAM_SECRET_HEADER]: 'wrong' }), env)).status).toBe(401);
    expect(kv.size).toBe(0);
    expect(stub.mock).not.toHaveBeenCalled();

    const ok = await handler(post('/telegram/webhook', update, signed), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, handled: 'linked' });
    expect(await kv.get(`link:${LINK_TOKEN_A}`)).toBe(CHAT_ID);
    expect(stub.calls[0]!.json).toMatchObject({ chat_id: CHAT_ID, text: 'Linked to Raksha. You will receive emergency alerts here.' });
  });

  it('full round trip: app polls /link (404) → caregiver taps → /link returns the chat id once', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const handler = createHandler();
    const env = paidEnv({}, kv);

    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), env)).status).toBe(404);
    await handler(post('/telegram/webhook', update, signed), env);
    const linked = await handler(post('/link', { linkToken: LINK_TOKEN_A }), env);
    expect(await linked.json()).toEqual({ telegramChatId: CHAT_ID });
    expect((await handler(post('/link', { linkToken: LINK_TOKEN_A }), env)).status).toBe(404);
    expect(kv.size).toBe(0);
  });

  it('is not gated by the app key or the rate limiter (Telegram is the caller)', async () => {
    stubFetchJson(200, { ok: true });
    const handler = createHandler({ limiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    const env = paidEnv();
    for (let i = 0; i < 3; i += 1) {
      expect((await handler(post('/telegram/webhook', update, { ...signed, [APP_KEY_HEADER]: null }), env)).status).toBe(200);
    }
  });

  it('400 on non-JSON, 413 when oversized, 200 ignored on an unrelated update', async () => {
    const handler = createHandler();
    const env = paidEnv();
    expect((await handler(post('/telegram/webhook', 'nope', signed), env)).status).toBe(400);
    expect((await handler(post('/telegram/webhook', update, { ...signed, 'Content-Length': String(MAX_BODY_BYTES + 1) }), env)).status).toBe(413);
    const ignored = await handler(post('/telegram/webhook', { update_id: 3, channel_post: {} }, signed), env);
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ok: true, handled: 'ignored' });
  });
});

describe('routing', () => {
  it('404 for unknown paths and tolerates a trailing slash', async () => {
    const handler = createHandler();
    expect((await handler(new Request(`${BASE}/nope`), makeEnv())).status).toBe(404);
    expect((await handler(new Request(`${BASE}/health/`), makeEnv())).status).toBe(200);
  });

  it('the default export wires the real handler', async () => {
    // The runtime hands the handler a Request carrying `cf` properties; a plain one is fine here.
    const request = new Request(`${BASE}/health`) as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
  });

  it('500 when the LINKS binding is missing on a link route', async () => {
    const response = await createHandler()(post('/link', { linkToken: LINK_TOKEN_A }), { CHANNEL_ORDER: '' } as unknown as Env);
    expect(response.status).toBe(500);
  });
});

describe('safeEqual', () => {
  it('compares exact strings only', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });
});
