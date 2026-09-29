import { describe, expect, it } from 'vitest';

import { TELEGRAM_API_BASE } from '../src/adapters/telegram';
import { TEXTBELT_URL } from '../src/adapters/textbelt';
import type { Adapter, SendOptions, SendResult } from '../src/adapters/types';
import type { ChannelName, SosRequest } from '../src/contract';
import { type AdapterMap, configuredChannels, DEADLINE_ERROR, DEADLINE_MS, dispatch, planChannels, SKIPPED_ERROR } from '../src/dispatch';
import { ADAPTERS } from '../src/index';
import { CHAT_ID, fullEnv, makeEnv, MESSAGE, PHONE } from './helpers/env';
import { stubFetch } from './helpers/fetch';

type FakeSpec = {
  configured?: boolean;
  needs: 'phone' | 'telegramChatId' | 'pushToken';
  results?: SendResult[];
  /** Called before answering; lets a test stall or move the clock. */
  before?: () => Promise<void> | void;
};

/** A scripted adapter: records what it was asked to send and answers from a queue. */
function fake(name: ChannelName, kind: Adapter['kind'], spec: FakeSpec): Adapter & { sent: string[]; options: SendOptions[] } {
  const queue = [...(spec.results ?? [{ ok: true }])];
  const adapter: Adapter & { sent: string[]; options: SendOptions[] } = {
    name,
    kind,
    sent: [],
    options: [],
    notConfiguredError: name === 'fcm' ? 'not implemented (M5 part 2)' : 'not configured',
    notApplicableError: `contact has no ${spec.needs}`,
    configured: () => spec.configured ?? true,
    applicable: (to) => to[spec.needs] !== undefined,
    async send(_to, message, _env, options) {
      adapter.sent.push(message);
      adapter.options.push(options ?? {});
      await spec.before?.();
      return queue.shift() ?? { ok: false, error: 'queue empty' };
    },
  };
  return adapter;
}

type Fakes = { [K in ChannelName]: ReturnType<typeof fake> };

function fakes(overrides: Partial<Record<ChannelName, FakeSpec>> = {}): Fakes {
  return {
    telegram: fake('telegram', 'data', { needs: 'telegramChatId', ...overrides.telegram }),
    textbelt: fake('textbelt', 'sms', { needs: 'phone', ...overrides.textbelt }),
    twilio: fake('twilio', 'sms', { needs: 'phone', configured: false, ...overrides.twilio }),
    fcm: fake('fcm', 'data', { needs: 'pushToken', configured: false, ...overrides.fcm }),
  };
}

function request(overrides: Partial<SosRequest> = {}): SosRequest {
  return { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE, channels: undefined, legacy: false, ...overrides };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('planChannels', () => {
  it('uses CHANNEL_ORDER when the request names no channels', () => {
    expect(planChannels(request(), fakes(), makeEnv({ CHANNEL_ORDER: 'textbelt,telegram' }))).toEqual(['textbelt', 'telegram']);
  });

  it('uses the requested order when at least one requested channel is configured', () => {
    expect(planChannels(request({ channels: ['textbelt', 'telegram'] }), fakes(), makeEnv())).toEqual(['textbelt', 'telegram']);
  });

  it('falls back to CHANNEL_ORDER when nothing requested is configured', () => {
    expect(planChannels(request({ channels: ['fcm', 'twilio'] }), fakes(), makeEnv())).toEqual(['telegram', 'textbelt']);
  });

  it('appends the preferred configured SMS adapter under SMS_ALWAYS when the plan has none', () => {
    expect(planChannels(request({ channels: ['telegram'] }), fakes(), makeEnv())).toEqual(['telegram', 'textbelt']);
    // Textbelt preferred; twilio only when textbelt is not configured.
    const twilioOnly = fakes({ textbelt: { needs: 'phone', configured: false }, twilio: { needs: 'phone', configured: true } });
    expect(planChannels(request({ channels: ['telegram'] }), twilioOnly, makeEnv())).toEqual(['telegram', 'twilio']);
  });

  it('appends a configured SMS adapter when the plan names only an unconfigured one', () => {
    // channels: ['telegram', 'twilio'] with Twilio unconfigured must still get Textbelt.
    expect(planChannels(request({ channels: ['telegram', 'twilio'] }), fakes(), makeEnv())).toEqual(['telegram', 'twilio', 'textbelt']);
  });

  it('does not append SMS without a phone number or with SMS_ALWAYS=false', () => {
    expect(planChannels(request({ to: { telegramChatId: CHAT_ID }, channels: ['telegram'] }), fakes(), makeEnv())).toEqual(['telegram']);
    expect(planChannels(request({ channels: ['telegram'] }), fakes(), makeEnv({ SMS_ALWAYS: 'false' }))).toEqual(['telegram']);
  });

  it('yields an empty plan when CHANNEL_ORDER is empty and nothing is requested', () => {
    expect(planChannels(request({ to: { telegramChatId: CHAT_ID } }), fakes(), makeEnv({ CHANNEL_ORDER: '' }))).toEqual([]);
  });
});

describe('dispatch', () => {
  it('delivers over the data channel and still sends one SMS (SMS_ALWAYS default)', async () => {
    const adapters = fakes();
    const response = await dispatch(request(), adapters, makeEnv());

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(adapters.telegram.sent).toEqual([MESSAGE]);
    expect(adapters.textbelt.sent).toEqual([MESSAGE]);
  });

  it('with SMS_ALWAYS off, stops after the first success and marks the rest skipped', async () => {
    const adapters = fakes();
    const response = await dispatch(request(), adapters, makeEnv({ SMS_ALWAYS: 'false' }));
    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: false, error: SKIPPED_ERROR },
      ],
    });
    expect(adapters.textbelt.sent).toEqual([]);
  });

  it('runs the SMS lane concurrently with the data lane, not after it', async () => {
    const started: Record<string, number> = {};
    const t0 = Date.now();
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', before: async () => { started['telegram'] = Date.now() - t0; await sleep(150); } },
      textbelt: { needs: 'phone', before: () => { started['textbelt'] = Date.now() - t0; } },
    });
    const response = await dispatch(request(), adapters, makeEnv());
    expect(response.delivered).toBe(true);
    // Textbelt started while Telegram was still in flight — well inside the 150 ms stall.
    expect(started['textbelt']).toBeLessThan(100);
    // Lower bound with tolerance: setTimeout can fire ~1 ms early relative to Date.now()
    // granularity (CI saw 149 for a 150 ms sleep). The upper bound is what the deadline tests pin.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('a hanging Telegram (real adapter, stubbed fetch) does not stop Textbelt within the deadline', async () => {
    const stub = stubFetch(
      (call) =>
        new Promise<Response>((resolve, reject) => {
          if (call.url.startsWith(TELEGRAM_API_BASE)) {
            const signal = call.init.signal!;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            return;
          }
          if (call.url === TEXTBELT_URL) resolve(Response.json({ success: true }));
        }),
    );
    const t0 = Date.now();
    const response = await dispatch(request(), ADAPTERS, fullEnv(), { timeoutMs: 100 });
    const wall = Date.now() - t0;

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram: timed out' },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(stub.calls.map((c) => c.url)).toEqual([`${TELEGRAM_API_BASE}/bottest-token/sendMessage`, TEXTBELT_URL]);
    expect(wall).toBeLessThan(DEADLINE_MS);
    expect(wall).toBeLessThan(1_000);
  });

  it('attempts exactly one SMS adapter after a data success even if it fails', async () => {
    const adapters = fakes({
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: Out of quota' }] },
      twilio: { needs: 'phone', configured: true },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota' },
        { channel: 'twilio', ok: false, error: SKIPPED_ERROR },
      ],
    });
    expect(adapters.twilio.sent).toEqual([]);
  });

  it('falls through every channel when there is no success, then reports 502-worthy failure', async () => {
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', results: [{ ok: false, error: 'telegram: timed out' }] },
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: Out of quota' }] },
      twilio: { needs: 'phone', configured: true, results: [{ ok: false, error: 'twilio 401: bad auth' }] },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));

    expect(response).toEqual({
      delivered: false,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram: timed out' },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota' },
        { channel: 'twilio', ok: false, error: 'twilio 401: bad auth' },
      ],
    });
  });

  it('a second SMS adapter is tried when the first SMS fails and nothing has been delivered', async () => {
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', results: [{ ok: false, error: 'telegram: unreachable' }] },
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: http 503' }] },
      twilio: { needs: 'phone', configured: true },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));
    expect(response.delivered).toBe(true);
    expect(response.results).toEqual([
      { channel: 'telegram', ok: false, error: 'telegram: unreachable' },
      { channel: 'textbelt', ok: false, error: 'textbelt: http 503' },
      { channel: 'twilio', ok: true },
    ]);
  });

  it('channels: [telegram, twilio] with Twilio unconfigured still sends via Textbelt', async () => {
    const adapters = fakes();
    const response = await dispatch(request({ channels: ['telegram', 'twilio'] }), adapters, makeEnv());
    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'twilio', ok: false, error: 'not configured' },
        { channel: 'textbelt', ok: true },
      ],
    });
  });

  it('an SMS success skips data channels that have not started yet', async () => {
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', before: () => sleep(30), results: [{ ok: false, error: 'telegram: unreachable' }] },
      fcm: { needs: 'pushToken', configured: true },
    });
    const response = await dispatch(
      request({ to: { phone: PHONE, telegramChatId: CHAT_ID, pushToken: 'tok' } }),
      adapters,
      makeEnv({ CHANNEL_ORDER: 'telegram,fcm,textbelt' }),
    );
    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram: unreachable' },
        { channel: 'fcm', ok: false, error: SKIPPED_ERROR },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(adapters.fcm.sent).toEqual([]);
  });

  it('records not-configured and not-applicable rows without calling those adapters', async () => {
    const adapters = fakes();
    const response = await dispatch(
      request({ to: { phone: PHONE } }),
      adapters,
      makeEnv({ CHANNEL_ORDER: 'fcm,telegram,twilio,textbelt' }),
    );

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'fcm', ok: false, error: 'not implemented (M5 part 2)' },
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'twilio', ok: false, error: 'not configured' },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(adapters.fcm.sent).toEqual([]);
    expect(adapters.telegram.sent).toEqual([]);
    expect(adapters.twilio.sent).toEqual([]);
  });

  it('legacy body: phone only + CHANNEL_ORDER → telegram skipped, SMS sent', async () => {
    const adapters = fakes();
    const response = await dispatch(request({ to: { phone: PHONE }, legacy: true }), adapters, makeEnv());
    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'textbelt', ok: true },
      ],
    });
  });

  it('an empty plan is a clean failure, not an exception', async () => {
    const response = await dispatch(request({ to: { telegramChatId: CHAT_ID } }), fakes(), makeEnv({ CHANNEL_ORDER: '' }));
    expect(response).toEqual({ delivered: false, results: [] });
  });

  it('passes the message through verbatim to every adapter', async () => {
    const adapters = fakes();
    const message = 'RAKSHA EMERGENCY - “quotes”, emoji 🚑, newline\nand trailing space ';
    await dispatch(request({ message }), adapters, makeEnv());
    expect(adapters.telegram.sent).toEqual([message]);
    expect(adapters.textbelt.sent).toEqual([message]);
  });

  describe('time budget', () => {
    it('gives each adapter the per-adapter timeout, capped by what is left of the deadline', async () => {
      let now = 0;
      const adapters = fakes({
        telegram: { needs: 'telegramChatId', before: () => { now += 6_500; }, results: [{ ok: false, error: 'telegram: timed out' }] },
      });
      await dispatch(request(), adapters, makeEnv({ SMS_ALWAYS: 'false' }), { now: () => now, timeoutMs: 3_500, deadlineMs: 8_000 });
      expect(adapters.telegram.options).toEqual([{ timeoutMs: 3_500 }]);
      // 6.5 s gone → only 1.5 s left for textbelt.
      expect(adapters.textbelt.options).toEqual([{ timeoutMs: 1_500 }]);
    });

    it('marks adapters that would start after the deadline as "deadline exceeded" without calling them', async () => {
      let now = 0;
      const adapters = fakes({
        telegram: { needs: 'telegramChatId', before: () => { now += 9_000; }, results: [{ ok: false, error: 'telegram: timed out' }] },
      });
      const response = await dispatch(request(), adapters, makeEnv({ SMS_ALWAYS: 'false' }), { now: () => now });
      expect(response).toEqual({
        delivered: false,
        results: [
          { channel: 'telegram', ok: false, error: 'telegram: timed out' },
          { channel: 'textbelt', ok: false, error: DEADLINE_ERROR },
        ],
      });
      expect(adapters.textbelt.sent).toEqual([]);
    });

    /** An adapter that ignores its abort signal and never settles — the worst upstream there is. */
    const hang = (): Promise<never> => new Promise<never>(() => undefined);

    it('abandons adapters that ignore their signal: rows say "deadline exceeded" and dispatch returns at the deadline', async () => {
      const adapters = fakes({
        telegram: { needs: 'telegramChatId', before: hang },
        textbelt: { needs: 'phone', before: hang },
      });
      const t0 = Date.now();
      const response = await dispatch(request(), adapters, makeEnv(), { deadlineMs: 150 });
      const wall = Date.now() - t0;

      expect(response).toEqual({
        delivered: false,
        results: [
          { channel: 'telegram', ok: false, error: DEADLINE_ERROR },
          { channel: 'textbelt', ok: false, error: DEADLINE_ERROR },
        ],
      });
      expect(wall).toBeGreaterThanOrEqual(140);
      expect(wall).toBeLessThan(DEADLINE_MS);
      expect(wall).toBeLessThan(1_000);
    });

    it('a hung data lane does not hold up an SMS success: delivered within the deadline', async () => {
      const adapters = fakes({ telegram: { needs: 'telegramChatId', before: hang } });
      const t0 = Date.now();
      const response = await dispatch(request(), adapters, makeEnv(), { deadlineMs: 150 });
      const wall = Date.now() - t0;

      expect(response).toEqual({
        delivered: true,
        results: [
          { channel: 'telegram', ok: false, error: DEADLINE_ERROR },
          { channel: 'textbelt', ok: true },
        ],
      });
      expect(wall).toBeLessThan(DEADLINE_MS);
      expect(wall).toBeLessThan(1_000);
    });

    it('sequential mode: a hung first adapter is abandoned and the next one gets a deadline row, not a wait', async () => {
      // The clock is injected so the boundary is exact. With a wall clock, a slow runner can
      // enter the second attempt with ~1 ms of budget left: the response is still correct (both
      // rows are `deadline exceeded`, nothing waits past the deadline) but `send` has been
      // called, which made this assertion flake on CI. Advancing the fake clock past the
      // deadline once the first adapter hangs pins the property the test is actually about:
      // the second adapter is never started after the budget is gone.
      const adapters = fakes({ telegram: { needs: 'telegramChatId', before: hang } });
      const t0 = Date.now();
      let clock = 0;
      const response = await dispatch(request(), adapters, makeEnv({ SMS_ALWAYS: 'false' }), {
        deadlineMs: 150,
        now: () => {
          const value = clock;
          clock = 200; // every read after the first is past the 150 ms deadline
          return value;
        },
      });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(response).toEqual({
        delivered: false,
        results: [
          { channel: 'telegram', ok: false, error: DEADLINE_ERROR },
          { channel: 'textbelt', ok: false, error: DEADLINE_ERROR },
        ],
      });
      expect(adapters.textbelt.sent).toEqual([]);
    });

    it('a late result from an abandoned adapter cannot change the response', async () => {
      let release: (() => void) | undefined;
      const adapters = fakes({
        telegram: { needs: 'telegramChatId', before: () => new Promise<void>((resolve) => { release = resolve; }) },
      });
      const response = await dispatch(request(), adapters, makeEnv(), { deadlineMs: 100 });
      expect(response.results[0]).toEqual({ channel: 'telegram', ok: false, error: DEADLINE_ERROR });
      release?.();
      await sleep(10);
      expect(response.results[0]).toEqual({ channel: 'telegram', ok: false, error: DEADLINE_ERROR });
    });

    it('defaults: 3.5 s per adapter under an 8 s deadline, both under the phone\'s 10 s', async () => {
      const adapters = fakes();
      await dispatch(request(), adapters, makeEnv());
      expect(adapters.telegram.options).toEqual([{ timeoutMs: 3_500 }]);
      expect(DEADLINE_MS).toBe(8_000);
    });
  });
});

describe('configuredChannels', () => {
  it('reports each adapter without touching the network', () => {
    const adapters: AdapterMap = fakes();
    expect(configuredChannels(adapters, makeEnv())).toEqual({ telegram: true, textbelt: true, twilio: false, fcm: false });
  });
});
