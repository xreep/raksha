/**
 * Relay client tests.
 *
 * Three things are pinned harder than the rest:
 *
 * 1. **The request body is exactly the relay's contract** (`relay/src/contract.ts`):
 *    `{ to: { phone, telegramChatId? }, message, channels }`. That shape crosses a process
 *    boundary this suite cannot see. If the app starts sending `{ phone, body }`, nothing here
 *    fails at runtime — the Worker 400s, and the app falls back to the composer for every
 *    contact, every time, with the relay looking healthy on `/health`. So the body is asserted
 *    by deep equality, not by "contains".
 * 2. **Success means `2xx` *and* `delivered: true`.** The Worker answers 502 when every channel
 *    failed, but the response handling does not rely on that alone: a 200 whose body says
 *    nothing was delivered is a failure here too, so a future relay change cannot turn an
 *    undelivered alert into a reported one.
 * 3. **Nothing throws.** The caller's whole job is to fall back to the composer, and it decides
 *    that from a returned value. An exception escaping this module would abort the dispatch and
 *    take the fallback with it, turning a relay outage into a total failure to alert.
 */

import { RELAY_APP_KEY_HEADER } from '@/sos/config';
import { relayChannelsFor, sendViaRelay } from '@/sos/relay';
import type { EmergencyContact } from '@/sos/types';

const ENDPOINT = 'https://phc-sos-relay.example.workers.dev/sos';
const MESSAGE = 'RAKSHA EMERGENCY - Asha needs help.';

const PHONE_ONLY: EmergencyContact = {
  id: 'c1',
  name: 'Meera',
  relation: 'Sister',
  phone: '+919876543210',
};

const LINKED: EmergencyContact = { ...PHONE_ONLY, id: 'c2', telegramChatId: '123456789' };

/**
 * Argument tuple for a `fetch` double.
 *
 * `Parameters<typeof fetch>` reads like the obvious spelling and is wrong: RN's `fetch` is
 * declared as overloads, and `Parameters` resolves only the *last* one (`input: RequestInfo`).
 * A mock typed from that is not assignable to `typeof fetch`, because it fails the first
 * overload's wider `URL | RequestInfo`. Declaring the widest input satisfies both.
 */
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

type RelayBody = {
  results?: readonly { channel: string; ok: boolean; error?: string }[];
  delivered?: boolean;
};

/** A response with a JSON body, the way the Worker answers. */
function reply(status: number, body: RelayBody | null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === null ? Promise.reject(new SyntaxError('empty')) : Promise.resolve(body)),
  } as unknown as Response;
}

const DELIVERED_TELEGRAM: RelayBody = {
  results: [
    { channel: 'telegram', ok: true },
    { channel: 'textbelt', ok: true },
  ],
  delivered: true,
};

/** An `AbortError` shaped the way `fetch` raises one. */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function fetchMock(response: Response) {
  return jest.fn<Promise<Response>, FetchArgs>().mockResolvedValue(response);
}

function bodyOf(fetchImpl: jest.Mock<Promise<Response>, FetchArgs>): unknown {
  return JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
}

const ORIGINAL_KEY = process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
  else process.env.EXPO_PUBLIC_SOS_RELAY_KEY = ORIGINAL_KEY;
});

describe('relayChannelsFor', () => {
  it('asks for the SMS channels only when the contact has no Telegram', () => {
    // The relay skips whichever of these is unconfigured; naming both lets a deployment switch
    // Twilio on without an app release (the point of ADR-007).
    expect(relayChannelsFor(PHONE_ONLY)).toEqual(['textbelt', 'twilio']);
  });

  it('puts Telegram first when the contact is linked', () => {
    // Order is a reporting order on the relay side (the SMS lane runs concurrently), but it
    // also states the preference: the free, unlimited channel before the one-a-day one.
    expect(relayChannelsFor(LINKED)).toEqual(['telegram', 'textbelt', 'twilio']);
  });

  it('never names fcm — that channel arrives with the caregiver role', () => {
    expect(relayChannelsFor(LINKED)).not.toContain('fcm');
  });
});

describe('sendViaRelay — the request', () => {
  it('POSTs the structured contract for a phone-only contact', async () => {
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });

    // Deep equality: the Worker validates `to` strictly and an extra or renamed field is a
    // silent contract change. `telegramChatId` is absent, not `undefined` — JSON has no
    // undefined, but the assertion pins that nothing sneaks a null in either.
    expect(bodyOf(fetchImpl)).toEqual({
      to: { phone: '+919876543210' },
      message: MESSAGE,
      channels: ['textbelt', 'twilio'],
    });
  });

  it('includes the chat id and asks for Telegram first when the contact is linked', async () => {
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    await sendViaRelay(LINKED, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(bodyOf(fetchImpl)).toEqual({
      to: { phone: '+919876543210', telegramChatId: '123456789' },
      message: MESSAGE,
      channels: ['telegram', 'textbelt', 'twilio'],
    });
  });

  it('sends the number as stored, without re-normalizing it', async () => {
    // `phone.ts` guarantees E.164 at the store boundary. A second normalization here could
    // disagree with what was saved, and the number the user verified in Settings would not be
    // the number that gets texted.
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    await sendViaRelay({ ...PHONE_ONLY, phone: '+14155550123' }, MESSAGE, {
      endpoint: ENDPOINT,
      fetchImpl,
    });

    expect((bodyOf(fetchImpl) as { to: { phone: string } }).to.phone).toBe('+14155550123');
  });

  it('sends no app-key header when none is configured', async () => {
    delete process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty(RELAY_APP_KEY_HEADER);
  });

  it('sends the configured app key as X-PHC-Key', async () => {
    // Optional on the relay for free channels, required once a paid SMS channel is on. A
    // deployment that set `RELAY_APP_KEY` answers 401 without this header.
    process.env.EXPO_PUBLIC_SOS_RELAY_KEY = 'phc-demo-key';
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers[RELAY_APP_KEY_HEADER]).toBe('phc-demo-key');
  });
});

describe('sendViaRelay — the response', () => {
  it('reports success, with the channels that carried it, on 2xx + delivered', async () => {
    const fetchImpl = fetchMock(reply(200, DELIVERED_TELEGRAM));

    const result = await sendViaRelay(LINKED, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({
      ok: true,
      channels: ['telegram', 'textbelt'],
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: true },
      ],
    });
  });

  it('lists only the channels that succeeded, keeping the failed rows for the audit trail', async () => {
    const fetchImpl = fetchMock(
      reply(200, {
        results: [
          { channel: 'telegram', ok: true },
          { channel: 'textbelt', ok: false, error: 'Textbelt: free SMS disabled for this country' },
          { channel: 'twilio', ok: false, error: 'not configured' },
        ],
        delivered: true,
      }),
    );

    const result = await sendViaRelay(LINKED, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels).toEqual(['telegram']);
      expect(result.results).toHaveLength(3);
      expect(result.results[1]).toEqual({
        channel: 'textbelt',
        ok: false,
        error: 'Textbelt: free SMS disabled for this country',
      });
    }
  });

  it('drops result rows for channels the app does not know', async () => {
    // The relay may name `fcm` (a stub until M5 part 2) or a channel added later. Unknown rows
    // are not a failure and not a success; they are simply not this build's business.
    const fetchImpl = fetchMock(
      reply(200, {
        results: [
          { channel: 'telegram', ok: true },
          { channel: 'fcm', ok: false, error: 'not implemented' },
          { channel: 'carrier_pigeon', ok: true },
        ],
        delivered: true,
      }),
    );

    const result = await sendViaRelay(LINKED, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({
      ok: true,
      channels: ['telegram'],
      results: [{ channel: 'telegram', ok: true }],
    });
  });

  it('treats 2xx with delivered:false as a failure, so the composer opens', async () => {
    // Belt and braces: the Worker answers 502 for this, but the app must not report an alert
    // as sent on the strength of a status code alone.
    const fetchImpl = fetchMock(
      reply(200, {
        results: [{ channel: 'textbelt', ok: false, error: 'quota exceeded' }],
        delivered: false,
      }),
    );

    const result = await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({
      ok: false,
      error: 'The SOS relay did not confirm delivery.',
      results: [{ channel: 'textbelt', ok: false, error: 'quota exceeded' }],
    });
  });

  it('treats a 2xx with no readable body as a failure rather than a success', async () => {
    // The legacy client accepted a bare 204. This one cannot: `delivered` is the only evidence
    // that a message reached a provider, and its absence is not evidence of anything.
    for (const status of [200, 204]) {
      const fetchImpl = fetchMock(reply(status, null));

      await expect(
        sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl }),
      ).resolves.toEqual({ ok: false, error: 'The SOS relay did not confirm delivery.' });
    }
  });

  it('falls back on 502, carrying the relay’s per-channel reasons', async () => {
    // Every channel failed. The reasons are what the failed-phase UI shows, and what a judge
    // reads when the demo Textbelt quota is spent.
    const fetchImpl = fetchMock(
      reply(502, {
        results: [
          { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
          { channel: 'textbelt', ok: false, error: 'Sorry, free SMS are disabled for this country' },
        ],
        delivered: false,
      }),
    );

    const result = await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({
      ok: false,
      error: 'The SOS relay could not deliver on any channel.',
      results: [
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'textbelt', ok: false, error: 'Sorry, free SMS are disabled for this country' },
      ],
    });
  });

  it('maps status codes to something a user can act on', async () => {
    const cases: readonly [number, string][] = [
      [400, 'The SOS relay returned an error (400).'],
      [401, 'The SOS relay rejected the request (check the app key).'],
      [403, 'The SOS relay rejected the request (check the app key).'],
      [404, 'The SOS relay URL was not found.'],
      [429, 'The SOS relay is rate limited.'],
      [500, 'The SOS relay failed (500).'],
      [502, 'The SOS relay could not deliver on any channel.'],
      [503, 'The SOS relay is not fully configured (503).'],
      [418, 'The SOS relay returned an error (418).'],
    ];

    for (const [status, error] of cases) {
      const fetchImpl = fetchMock(reply(status, null));

      await expect(
        sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl }),
      ).resolves.toEqual({ ok: false, error });
    }
  });

  it('never leaks the endpoint into an error message', async () => {
    // Errors are rendered in the SOS modal. A URL there is noise to the user and a detail worth
    // not putting on a screenshot.
    const fetchImpl = fetchMock(reply(500, null));

    const result = await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('workers.dev');
  });

  it('reports a network failure as data rather than throwing', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockRejectedValue(new TypeError('Network request failed'));

    await expect(
      sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl }),
    ).resolves.toEqual({ ok: false, error: 'Could not reach the SOS relay.' });
  });

  it('never throws, even when fetch itself throws synchronously', async () => {
    const fetchImpl = jest.fn(() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await expect(
      sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl }),
    ).resolves.toEqual({ ok: false, error: 'Could not reach the SOS relay.' });
  });

  it('names a timeout specifically, so the fallback reads as expected and not as a bug', async () => {
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>().mockRejectedValue(abortError());

    await expect(
      sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: ENDPOINT, fetchImpl }),
    ).resolves.toEqual({ ok: false, error: 'The SOS relay timed out.' });
  });

  it('aborts on its own timeout, so a hung request cannot hold the alert forever', async () => {
    jest.useFakeTimers();
    try {
      // A `fetch` that resolves only when its signal aborts — the shape of a request against a
      // black-holed connection, which is what "no connectivity" often looks like in practice.
      const fetchImpl = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        });
      }) as unknown as typeof fetch;

      const pending = sendViaRelay(PHONE_ONLY, MESSAGE, {
        endpoint: ENDPOINT,
        fetchImpl,
        timeoutMs: 10_000,
      });

      jest.advanceTimersByTime(10_000);

      await expect(pending).resolves.toEqual({ ok: false, error: 'The SOS relay timed out.' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('honours a caller abort, and composes it with the timeout rather than replacing it', async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    }) as unknown as typeof fetch;

    const pending = sendViaRelay(PHONE_ONLY, MESSAGE, {
      endpoint: ENDPOINT,
      fetchImpl,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'The SOS relay timed out.' });
  });

  it('says "not configured" rather than "failed" when there is no endpoint', async () => {
    // A materially different thing to tell a user: one is a build they can fix, the other looks
    // like an outage. The flag is what lets Settings show relay status before it is needed.
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>();

    const result = await sendViaRelay(PHONE_ONLY, MESSAGE, { endpoint: null, fetchImpl });

    expect(result).toEqual({
      ok: false,
      notConfigured: true,
      error: 'No SOS relay configured. Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local.',
    });
    // And it must not spend the 10-second timeout proving it.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
