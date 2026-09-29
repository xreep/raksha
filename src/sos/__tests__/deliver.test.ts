/**
 * Delivery orchestration tests.
 *
 * This is where the escalation's judgement calls live, and each one is a case where the obvious
 * implementation is wrong in a way no user would report:
 *
 * - **Fallback is per-contact.** A relay that is up but cannot deliver to one contact must not
 *   push the whole list into a composer — the contacts it already reached would be texted a
 *   second time, and duplicate emergency messages are their own harm.
 * - **One channel is enough.** Telegram delivered and SMS failed is a reached contact; the
 *   composer stays shut for them, and both rows are kept so the UI can say which lane worked.
 * - **`cancelled` is not pending.** The user saw the composer and dismissed it. Nothing is
 *   waiting for them, so a "waiting for you to press send" banner would be false.
 * - **`failed` means nothing got out.** A composer that opened counts as progress, because the
 *   user can still complete it. Calling that failed would send them looking for a second way to
 *   raise the alarm while the first sits on screen, one tap from done.
 * - **The relay runs concurrently.** Three unreachable contacts at a 10-second timeout each is
 *   30 seconds before the composer opens, on top of the 30-second cancel window already spent.
 */

import { dispatchSos } from '@/sos/deliver';
import type { EmergencyContact, SosContext } from '@/sos/types';

const NOW = 1_766_000_000_000;

const MEERA: EmergencyContact = {
  id: 'c1',
  name: 'Meera',
  relation: 'Sister',
  phone: '+919876543210',
  telegramChatId: '123456789',
};
const RAVI: EmergencyContact = { id: 'c2', name: 'Ravi', relation: 'Neighbour', phone: '+919123456780' };

const CONTACTS: readonly EmergencyContact[] = [MEERA, RAVI];

const CONTEXT: SosContext = {
  criticalRules: ['respiratory.spo2.critical'],
  level: 'red',
  vitals: { hr: 132, spo2: 84 },
  location: {
    ok: true,
    location: { latitude: 13.0827, longitude: 80.2707, accuracyM: 12, timestamp: NOW },
  },
  userName: 'Asha',
  now: NOW,
  manual: false,
};

type Row = { channel: string; ok: boolean; error?: string };
type Verdict = 'ok' | 'telegram_only' | 'network' | number;

/** What the Worker answers for each verdict, in its real shape. */
function replyFor(verdict: Verdict, channels: readonly string[]): { status: number; body: unknown } {
  if (verdict === 'ok') {
    return { status: 200, body: { results: channels.map((channel) => ({ channel, ok: true })), delivered: true } };
  }
  if (verdict === 'telegram_only') {
    const results: Row[] = channels.map((channel) =>
      channel === 'telegram'
        ? { channel, ok: true }
        : { channel, ok: false, error: channel === 'twilio' ? 'not configured' : 'quota exceeded' },
    );
    return { status: 200, body: { results, delivered: true } };
  }
  if (verdict === 502) {
    const results: Row[] = channels.map((channel) => ({ channel, ok: false, error: `${channel} failed` }));
    return { status: 502, body: { results, delivered: false } };
  }
  return { status: verdict as number, body: null };
}

/** A `fetch` that answers per phone number, so partial-failure cases are expressible. */
function relay(outcome: (phone: string) => Verdict) {
  return jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { to, channels } = JSON.parse(String(init?.body)) as {
      to: { phone: string };
      channels: string[];
    };
    const verdict = outcome(to.phone);
    if (verdict === 'network') throw new TypeError('Network request failed');
    const { status, body } = replyFor(verdict, channels);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => (body === null ? Promise.reject(new SyntaxError('empty')) : Promise.resolve(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function sms(overrides: { available?: boolean; result?: string } = {}) {
  const { available = true, result = 'sent' } = overrides;
  return {
    isAvailableAsync: jest.fn(() => Promise.resolve(available)),
    sendSMSAsync: jest.fn(() => Promise.resolve({ result })),
  };
}

const ENDPOINT = 'https://phc-sos-relay.example.workers.dev/sos';

describe('dispatchSos — the relay reaches everyone', () => {
  it('reports delivered per contact with the channels that carried it, and no composer', async () => {
    const fetchImpl = relay(() => 'ok');
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.relayDelivered).toEqual([
      { contactId: 'c1', channels: ['telegram', 'textbelt', 'twilio'] },
      { contactId: 'c2', channels: ['textbelt', 'twilio'] },
    ]);
    expect(result.nativeSmsPending).toBe(false);
    expect(result.failed).toBe(false);
    expect(smsImpl.sendSMSAsync).not.toHaveBeenCalled();
    // One row per contact per channel, straight from the relay's results.
    expect(result.attempts).toEqual([
      { contactId: 'c1', phone: '+919876543210', channel: 'telegram', ok: true, error: undefined },
      { contactId: 'c1', phone: '+919876543210', channel: 'textbelt', ok: true, error: undefined },
      { contactId: 'c1', phone: '+919876543210', channel: 'twilio', ok: true, error: undefined },
      { contactId: 'c2', phone: '+919123456780', channel: 'textbelt', ok: true, error: undefined },
      { contactId: 'c2', phone: '+919123456780', channel: 'twilio', ok: true, error: undefined },
    ]);
  });

  it('sends one identical message to every contact', async () => {
    // Not personalised on purpose: the content is identical by nature, and per-contact variants
    // would multiply the ways a bug could produce a *different* emergency message for one
    // recipient than another.
    const fetchImpl = relay(() => 'ok');

    const result = await dispatchSos(CONTACTS, CONTEXT, { relay: { endpoint: ENDPOINT, fetchImpl } });

    const bodies = (fetchImpl as jest.Mock).mock.calls.map(
      (call) => (JSON.parse(String(call[1]?.body)) as { message: string }).message,
    );
    expect(bodies).toEqual([result.message, result.message]);
    expect(result.message).toContain('RAKSHA EMERGENCY - Asha needs help.');
  });

  it('sends each contact’s own destination and channel list', async () => {
    // The linked contact gets her chat id and Telegram first; the other gets neither. Mixing
    // them up would send Meera's Telegram alert to Ravi's entry, which the relay would reject
    // as "contact has no telegramChatId" — a silent downgrade to SMS for the one contact who
    // linked.
    const fetchImpl = relay(() => 'ok');

    await dispatchSos(CONTACTS, CONTEXT, { relay: { endpoint: ENDPOINT, fetchImpl } });

    const bodies = (fetchImpl as jest.Mock).mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual([
      expect.objectContaining({
        to: { phone: '+919876543210', telegramChatId: '123456789' },
        channels: ['telegram', 'textbelt', 'twilio'],
      }),
      expect.objectContaining({ to: { phone: '+919123456780' }, channels: ['textbelt', 'twilio'] }),
    ]);
  });

  it('dispatches concurrently rather than one contact at a time', async () => {
    // Both requests must be in flight together. Sequentially, an unreachable list costs the
    // full relay timeout per contact before the fallback composer even opens.
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [], delivered: true }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await dispatchSos(CONTACTS, CONTEXT, { relay: { endpoint: ENDPOINT, fetchImpl } });

    expect(peak).toBe(2);
  });
});

describe('dispatchSos — partial delivery', () => {
  it('counts a contact as reached when Telegram landed and the SMS lane failed', async () => {
    // One channel is enough to put the alert in front of a person. Opening the composer for
    // Meera here would text her a second time.
    const fetchImpl = relay((phone) => (phone === '+919876543210' ? 'telegram_only' : 'ok'));
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.relayDelivered).toEqual([
      { contactId: 'c1', channels: ['telegram'] },
      { contactId: 'c2', channels: ['textbelt', 'twilio'] },
    ]);
    expect(smsImpl.sendSMSAsync).not.toHaveBeenCalled();
    expect(result.nativeSmsPending).toBe(false);
    expect(result.failed).toBe(false);
    // The failed lanes are still on record, with the relay's own reasons.
    expect(result.attempts.filter((a) => a.contactId === 'c1')).toEqual([
      { contactId: 'c1', phone: '+919876543210', channel: 'telegram', ok: true, error: undefined },
      { contactId: 'c1', phone: '+919876543210', channel: 'textbelt', ok: false, error: 'quota exceeded' },
      { contactId: 'c1', phone: '+919876543210', channel: 'twilio', ok: false, error: 'not configured' },
    ]);
  });

  it('falls back for only the contact the relay could not deliver to', async () => {
    const fetchImpl = relay((phone) => (phone === '+919876543210' ? 'ok' : 502));
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.relayDelivered.map((d) => d.contactId)).toEqual(['c1']);
    // The composer is addressed to c2 alone. Including c1 would text them twice.
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(['+919123456780'], result.message);
    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('records a row per contact per channel, so the UI can show a complete picture', async () => {
    const fetchImpl = relay((phone) => (phone === '+919876543210' ? 'ok' : 502));

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl: sms() },
    });

    expect(result.attempts.filter((a) => a.contactId === 'c2')).toEqual([
      // The relay's 502 body names each channel's reason…
      { contactId: 'c2', phone: '+919123456780', channel: 'textbelt', ok: false, error: 'textbelt failed' },
      { contactId: 'c2', phone: '+919123456780', channel: 'twilio', ok: false, error: 'twilio failed' },
      // …and then the composer row.
      { contactId: 'c2', phone: '+919123456780', channel: 'native_sms', ok: true, error: undefined },
    ]);
  });

  it('gives every planned channel the same reason when the relay was not reached at all', async () => {
    // A timeout or a network failure has no per-channel body. The audit trail still has one
    // row per channel — the channels that *would* have been tried — rather than a row for a
    // channel called "relay" that the UI would then have to explain.
    const fetchImpl = relay((phone) => (phone === '+919876543210' ? 'network' : 500));

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl: sms() },
    });

    expect(result.attempts.filter((a) => a.channel !== 'native_sms')).toEqual([
      { contactId: 'c1', phone: '+919876543210', channel: 'telegram', ok: false, error: 'Could not reach the SOS relay.' },
      { contactId: 'c1', phone: '+919876543210', channel: 'textbelt', ok: false, error: 'Could not reach the SOS relay.' },
      { contactId: 'c1', phone: '+919876543210', channel: 'twilio', ok: false, error: 'Could not reach the SOS relay.' },
      { contactId: 'c2', phone: '+919123456780', channel: 'textbelt', ok: false, error: 'The SOS relay failed (500).' },
      { contactId: 'c2', phone: '+919123456780', channel: 'twilio', ok: false, error: 'The SOS relay failed (500).' },
    ]);
  });
});

describe('dispatchSos — the relay reaches nobody', () => {
  it('rolls the whole list into one composer', async () => {
    const fetchImpl = relay(() => 'network');
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.relayDelivered).toEqual([]);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(
      ['+919876543210', '+919123456780'],
      result.message,
    );
    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('falls back when no relay is configured, without waiting for a timeout', async () => {
    // The unconfigured build. This is why a missing `EXPO_PUBLIC_SOS_RELAY_URL` is a
    // degradation and not an outage: the alert still reaches a composer.
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: null },
      sms: { smsImpl },
    });

    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.attempts.filter((a) => a.channel === 'native_sms')).toHaveLength(2);
    expect(result.attempts[0].error).toContain('No SOS relay configured');
  });

  it('fails only when the composer could not open either', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: null },
      sms: { smsImpl: sms({ available: false }) },
    });

    expect(result.failed).toBe(true);
    expect(result.nativeSmsPending).toBe(false);
    expect(result.attempts.filter((a) => a.channel === 'native_sms')).toEqual([
      {
        contactId: 'c1',
        phone: '+919876543210',
        channel: 'native_sms',
        ok: false,
        error: 'This device cannot send SMS.',
      },
      {
        contactId: 'c2',
        phone: '+919123456780',
        channel: 'native_sms',
        ok: false,
        error: 'This device cannot send SMS.',
      },
    ]);
  });
});

describe('dispatchSos — skipRelay', () => {
  it('goes straight to the composer without touching the network', async () => {
    // PRD §7.2.5's "no connectivity" branch. The caller already knows the network is down;
    // spending 10 seconds of an emergency re-proving it is the cost this avoids.
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      skipRelay: true,
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(
      ['+919876543210', '+919123456780'],
      result.message,
    );
    // No relay rows at all — the path was not attempted, which is different from having failed.
    expect(result.attempts.every((a) => a.channel === 'native_sms')).toBe(true);
    expect(result.nativeSmsPending).toBe(true);
  });
});

describe('dispatchSos — composer outcomes', () => {
  it('does not report pending when the user dismissed the composer', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: null },
      sms: { smsImpl: sms({ result: 'cancelled' }) },
    });

    expect(result.nativeSmsPending).toBe(false);
    // Recorded as an `ok` attempt, though: the composer did open. The user made a choice, and
    // that is not a delivery failure to escalate.
    expect(result.attempts.filter((a) => a.channel === 'native_sms').every((a) => a.ok)).toBe(true);
    // But with nothing sent and nothing pending, the dispatch as a whole achieved nothing.
    expect(result.failed).toBe(true);
  });

  it('reports pending on an unknown outcome, because iOS often declines to say', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: null },
      sms: { smsImpl: sms({ result: 'unknown' }) },
    });

    expect(result.nativeSmsPending).toBe(true);
  });

  it('still reports pending when the relay reached some contacts', async () => {
    // Pending outranks sent in the UI for a reason — the honest headline is the thing that
    // still needs the user. Both facts are kept here so the modal can say both.
    const fetchImpl = relay((phone) => (phone === '+919876543210' ? 'ok' : 'network'));

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl: sms() },
    });

    expect(result.relayDelivered.map((d) => d.contactId)).toEqual(['c1']);
    expect(result.nativeSmsPending).toBe(true);
  });
});

describe('dispatchSos — degenerate input', () => {
  it('fails with a composed message when there are no contacts', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const smsImpl = sms();

    const result = await dispatchSos([], CONTEXT, {
      relay: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.failed).toBe(true);
    expect(result.attempts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smsImpl.sendSMSAsync).not.toHaveBeenCalled();
    // The message is still composed. The machine refuses this case before it gets here, but a
    // result with an empty `message` would render a blank "what was sent" disclosure if it ever
    // did — and an empty string is indistinguishable from a composition bug.
    expect(result.message).toContain('RAKSHA EMERGENCY');
  });

  it('sends an alert with no coordinates rather than no alert', async () => {
    // The property the whole location layer is built around: a failed fix degrades the message,
    // it does not abort the dispatch.
    const fetchImpl = relay(() => 'ok');

    const result = await dispatchSos(
      CONTACTS,
      { ...CONTEXT, location: { ok: false, reason: 'timeout' } },
      { relay: { endpoint: ENDPOINT, fetchImpl } },
    );

    expect(result.relayDelivered.map((d) => d.contactId)).toEqual(['c1', 'c2']);
    expect(result.message).toContain('Location: unavailable (no GPS fix in time)');
  });

  it('never throws, even when both paths blow up', async () => {
    const fetchImpl = jest.fn(() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await expect(
      dispatchSos(CONTACTS, CONTEXT, {
        relay: { endpoint: ENDPOINT, fetchImpl },
        sms: {
          smsImpl: {
            isAvailableAsync: () => Promise.reject(new Error('boom')),
            sendSMSAsync: () => Promise.reject(new Error('boom')),
          },
        },
      }),
    ).resolves.toMatchObject({ failed: true });
  });
});
