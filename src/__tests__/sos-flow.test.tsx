/**
 * SOS end-to-end flow.
 *
 * The unit suites next to each module prove the pieces: `machine.test.ts` owns the transition
 * rules, `deliver.test.ts` owns the escalation, `message.test.ts` owns the text. What none of
 * them can prove is that the pieces are *wired together* — that a critical reading coming out
 * of the risk engine actually arms a countdown, that the countdown actually closes after 30
 * seconds of wall time, and that closing it actually sends. Every one of those could be
 * disconnected while all 132 unit tests stayed green, and the failure would first be observed
 * by someone having a medical emergency.
 *
 * So this file assembles the real thing and stubs only at the two edges the test process cannot
 * cross: `fetch` (the emergency relay, answering in its real shape) and `expo-sms` (the platform
 * composer).
 * `assessRisk`, `useSos`, `sosReducer`, `dispatchSos`, `composeSosMessage`, `SosAlert`, the
 * settings store and AsyncStorage are all the shipping code.
 *
 * ## Why the clock is injected rather than mocked globally
 * The countdown measures elapsed wall time — the one quantity in this app that genuinely cannot
 * be derived from the data. Fake timers drive the interval; a separate mutable `clock` drives
 * `nowImpl`, so a test can hold time still while the interval fires (proving ticks alone do not
 * dispatch) and then step over the boundary by a single millisecond.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useMemo } from 'react';
import { Pressable } from 'react-native';

import { SosAlert } from '@/components/sos-alert';
import { ThemedText } from '@/components/themed-text';
import { useSos, type UseSosOptions } from '@/hooks/use-sos';
import { assessRisk, type SensorReading } from '@/risk';
import { SettingsProvider } from '@/settings/provider';
import { SETTINGS_KEY } from '@/settings/store';
import type { DispatchOptions } from '@/sos/deliver';

const T0 = 1_766_000_000_000;

const CONTACTS = [
  { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210', telegramChatId: '123456789' },
  { id: 'c2', name: 'Ravi', relation: 'Neighbour', phone: '+919123456780' },
];

/**
 * Two confirmed sub-85 % readings, which is what `respiratory.spo2.critical` requires — the
 * assessment is *computed*, not hand-written, so this test also fails if the engine stops
 * reporting the trigger the SOS module listens for.
 */
const DESATURATING: readonly SensorReading[] = [
  { source: 'simulated', timestamp: T0 - 60_000, hr: 118, spo2: 83, skinTempC: 37.2 },
  { source: 'simulated', timestamp: T0 - 30_000, hr: 124, spo2: 82, skinTempC: 37.3 },
];

const HEALTHY: readonly SensorReading[] = [
  { source: 'simulated', timestamp: T0 - 60_000, hr: 72, spo2: 98, skinTempC: 33.1 },
  { source: 'simulated', timestamp: T0 - 30_000, hr: 74, spo2: 97, skinTempC: 33.2 },
];

const FIX = {
  ok: true as const,
  location: { latitude: 13.0827, longitude: 80.2707, accuracyM: 12, timestamp: T0 },
};

const ENDPOINT = 'https://phc-sos-relay.example.workers.dev/sos';
const originalRelay = process.env.EXPO_PUBLIC_SOS_RELAY_URL;

/** Mutable wall clock. Advanced only by `advance`, so ticks are observable separately. */
let clock = T0;

function Harness({
  readings,
  options,
}: {
  readings: readonly SensorReading[];
  options: UseSosOptions;
}) {
  // The real engine, on the real readings. `now` is fixed so the assessment is deterministic;
  // it is also what the machine uses as the arming instant.
  const assessment = useMemo(() => assessRisk({ readings, now: T0 }), [readings]);
  const sos = useSos({ assessment, latest: readings[readings.length - 1] ?? null }, options);

  return (
    <>
      <Pressable accessibilityRole="button" onPress={sos.press}>
        <ThemedText>Emergency SOS</ThemedText>
      </Pressable>
      <SosAlert controller={sos} />
    </>
  );
}

function renderFlow(readings: readonly SensorReading[], options: UseSosOptions) {
  return render(
    <SettingsProvider>
      <Harness readings={readings} options={options} />
    </SettingsProvider>,
  );
}

/** Step wall time and let the countdown interval catch up to it. */
async function advance(ms: number) {
  clock += ms;
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * A `fetch` that reports one verdict for every contact, answering in the relay's real shape:
 * `{ results: [{ channel, ok, error? }], delivered }`. `'ok'` reports the first requested
 * channel as delivered, so a linked contact reads "via Telegram" and an unlinked one "via SMS".
 */
function relay(verdict: 'ok' | 'network' | number) {
  return jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (verdict === 'network') throw new TypeError('Network request failed');
    const { channels } = JSON.parse(String(init?.body)) as { channels: string[] };
    if (verdict === 'ok') {
      const body = {
        results: channels.map((channel, index) => ({ channel, ok: index === 0 })),
        delivered: true,
      };
      return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
    }
    return {
      ok: false,
      status: verdict,
      json: () => Promise.reject(new SyntaxError('empty')),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function composer(result = 'sent') {
  return {
    isAvailableAsync: jest.fn(() => Promise.resolve(true)),
    // Declared parameters, ignored body: without them `jest.fn` infers a zero-argument mock and
    // `mock.calls[0][0]` — the recipient list this test exists to check — is a type error.
    sendSMSAsync: jest.fn((_recipients: string | string[], _message: string) =>
      Promise.resolve({ result }),
    ),
  };
}

beforeEach(async () => {
  jest.useFakeTimers();
  clock = T0;
  await AsyncStorage.clear();
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ contacts: CONTACTS, userName: 'Asha' }),
  );
  process.env.EXPO_PUBLIC_SOS_RELAY_URL = ENDPOINT;
});

afterEach(() => {
  jest.useRealTimers();
  if (originalRelay === undefined) delete process.env.EXPO_PUBLIC_SOS_RELAY_URL;
  else process.env.EXPO_PUBLIC_SOS_RELAY_URL = originalRelay;
});

/** Options with the two process boundaries stubbed and everything in between real. */
function options(overrides: {
  dispatchOptions?: DispatchOptions;
  vibrate?: jest.Mock;
  cancelVibration?: jest.Mock;
  location?: UseSosOptions['resolveLocationImpl'];
}): UseSosOptions {
  return {
    nowImpl: () => clock,
    resolveLocationImpl: overrides.location ?? (() => Promise.resolve(FIX)),
    vibrateImpl: overrides.vibrate ?? jest.fn(),
    cancelVibrationImpl: overrides.cancelVibration ?? jest.fn(),
    dispatchOptions: overrides.dispatchOptions,
  };
}

describe('a critical reading arms the cancel window', () => {
  it('opens the countdown naming the computed reason, not a generic alert', async () => {
    const screen = await renderFlow(DESATURATING, options({}));

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());

    // 30 whole seconds, PRD §7.2.5. Read through the accessibility label because the digit
    // itself is a bare number that would match anything.
    expect(screen.getByLabelText('30 seconds to cancel')).toBeTruthy();
    expect(screen.getByText('Alerting 2 contacts in 30s')).toBeTruthy();
    // Verbatim from the same table the SMS body uses, so what is on screen during the window is
    // what the contacts will read.
    expect(screen.getByText('· Blood oxygen critically low')).toBeTruthy();
    // Who it will reach, before it reaches them.
    expect(screen.getByText('Meera · +91 98765 43210')).toBeTruthy();
    expect(screen.getByText('Ravi · +91 91234 56780')).toBeTruthy();
  });

  it('stays idle on a healthy reading', async () => {
    const screen = await renderFlow(HEALTHY, options({}));

    await act(async () => {});
    await advance(60_000);

    expect(screen.queryByText('CRITICAL RISK DETECTED')).toBeNull();
    expect(screen.queryByText('SENDING')).toBeNull();
  });

  it('vibrates while the window is open and stops the moment it closes', async () => {
    // PRD §7.2.5 step 1's local alert. A vibration that outlives the window keeps buzzing
    // through the outcome screen, which reads as a device fault.
    const vibrate = jest.fn();
    const cancelVibration = jest.fn();
    const screen = await renderFlow(DESATURATING, options({ vibrate, cancelVibration }));

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    expect(vibrate).toHaveBeenCalledWith([0, 600, 250, 600, 250, 900], true);
    expect(cancelVibration).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("Cancel — I'm OK"));

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy());
    expect(cancelVibration).toHaveBeenCalled();
  });

  it('does not send while the user still has time to cancel', async () => {
    // The interval fires 119 times in this test. None of them may commit the alert — only
    // elapsed wall time can, and this is the assertion that catches a tick handler that
    // dispatches on every beat.
    const fetchImpl = relay('ok');
    const sms = composer();
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl }, sms: { smsImpl: sms } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(29_999);

    expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy();
    expect(screen.getByLabelText('1 seconds to cancel')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sms.sendSMSAsync).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('sends nothing at all', async () => {
    const fetchImpl = relay('ok');
    const sms = composer();
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl }, sms: { smsImpl: sms } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await fireEvent.press(screen.getByText("Cancel — I'm OK"));

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sms.sendSMSAsync).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'No alert was sent. You will be warned again if a new critical reading appears.',
      ),
    ).toBeTruthy();
  });

  it('does not re-arm from the same reading after the user says they are OK', async () => {
    // The reason `suppressedSignature` exists. The engine re-evaluates every 60 s and a real
    // desaturation stays true across ticks, so without suppression the modal would reappear a
    // minute after being dismissed — and keep reappearing.
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await fireEvent.press(screen.getByText("Cancel — I'm OK"));
    await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy());
    await fireEvent.press(screen.getByText('Done'));

    await advance(600_000);

    expect(screen.queryByText('CRITICAL RISK DETECTED')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the window closing commits the alert', () => {
  it('sends through the relay and shows what went out', async () => {
    const fetchImpl = relay('ok');
    const sms = composer();
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl }, sms: { smsImpl: sms } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('SENT')).toBeTruthy());
    expect(screen.getByText('Delivered to 2 contacts.')).toBeTruthy();
    // Per contact, naming the channel the relay reported — the linked contact on Telegram, the
    // other by SMS gateway. What the user reads is what the relay said, not a guess.
    expect(screen.getByText('· Sent to Meera via Telegram')).toBeTruthy();
    expect(screen.getByText('· Sent to Ravi via SMS')).toBeTruthy();
    // The composer stayed shut: the primary path worked, so nothing needs the user.
    expect(sms.sendSMSAsync).not.toHaveBeenCalled();

    // One POST per contact, each carrying the relay's structured contract: the linked contact
    // sends her chat id and asks for Telegram first; the other sends neither.
    const calls = (fetchImpl as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const bodies = calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: { phone: '+919876543210', telegramChatId: '123456789' },
          channels: ['telegram', 'textbelt', 'twilio'],
        }),
        expect.objectContaining({ to: { phone: '+919123456780' }, channels: ['textbelt', 'twilio'] }),
      ]),
    );

    // The whole chain in one assertion: engine → machine → location → composer → relay. The
    // name comes from settings, the reason from the engine's `criticalRules`, the vitals from
    // the reading, the coordinates from the location resolver.
    const sentBody = JSON.parse(String(calls[0][1]?.body)).message as string;
    expect(sentBody).toContain('RAKSHA EMERGENCY - Asha needs help.');
    expect(sentBody).toContain('Reason: Blood oxygen critically low.');
    expect(sentBody).toContain('Vitals: HR 124 bpm, SpO2 82%, skin 37.3C');
    expect(sentBody).toContain('Location: 13.082700, 80.270700 (+/-12m)');

    // And the same text is shown back to the user, so they know what their contacts received.
    expect(screen.getByText(sentBody)).toBeTruthy();
  });

  it('falls back to the SMS composer when the relay cannot be reached', async () => {
    // PRD §7.2.5's fallback, end to end. The relay is configured and simply fails — the case a
    // patchy network produces, and the one where a silent failure would be worst.
    const fetchImpl = relay('network');
    const sms = composer();
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl }, sms: { smsImpl: sms } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('NEEDS ONE MORE TAP')).toBeTruthy());
    expect(screen.getByText('Press send in your SMS app')).toBeTruthy();
    // Named per contact, and "opened", never "sent".
    expect(screen.getByText('· Opened SMS app for Meera')).toBeTruthy();
    expect(screen.getByText('· Opened SMS app for Ravi')).toBeTruthy();

    // One composer for both contacts, addressed in E.164.
    expect(sms.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(sms.sendSMSAsync.mock.calls[0][0]).toEqual(['+919876543210', '+919123456780']);

    // The "not sent yet" warning. Asserted as two independent fragments because the sentence is
    // split across nested `ThemedText` for the bold "not" — a whole-sentence match would pass
    // just as happily if the negation were dropped, which is the one word that carries the
    // meaning.
    expect(screen.getByText('not')).toBeTruthy();
    expect(screen.getAllByText(/press send there to alert your contacts/)).not.toHaveLength(0);
  });

  it('says it sent nothing when neither channel worked', async () => {
    const screen = await renderFlow(
      DESATURATING,
      options({
        dispatchOptions: {
          relay: { endpoint: ENDPOINT, fetchImpl: relay(500) },
          sms: {
            smsImpl: {
              isAvailableAsync: () => Promise.resolve(false),
              sendSMSAsync: () => Promise.resolve({ result: 'sent' }),
            },
          },
        },
      }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('NOT SENT')).toBeTruthy());
    // Told what to do instead, rather than left with a failure and no next step.
    expect(screen.getByText('Nothing was delivered. Call your emergency contact directly.')).toBeTruthy();
    // One line per contact per reason: the relay left the same reason on every channel row
    // for a contact, and the overlay collapses those rather than printing it three times.
    expect(screen.getAllByText('· The SOS relay failed (500).')).toHaveLength(2);
    expect(screen.getAllByText('· This device cannot send SMS.')).toHaveLength(2);
  });

  it('sends without coordinates rather than not sending', async () => {
    // The property the location layer is built around, proven through the UI: a failed fix
    // degrades the message and the alert still goes out.
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      DESATURATING,
      options({
        location: () => Promise.resolve({ ok: false, reason: 'timeout' }),
        dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } },
      }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('SENT')).toBeTruthy());
    const body = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body)).message;
    expect(body).toContain('Location: unavailable (no GPS fix in time)');
  });

  it('cannot be cancelled once committed', async () => {
    // A relay that never answers, so the dispatching phase is observable. There is no cancel
    // affordance here on purpose: the messages are already going out and a button that cannot
    // recall them would be a lie.
    const fetchImpl = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('SENDING')).toBeTruthy());
    expect(
      screen.getByText('Getting your location and sending the alert. This cannot be cancelled.'),
    ).toBeTruthy();
    expect(screen.queryByText("Cancel — I'm OK")).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('does not re-send the same trigger a minute later', async () => {
    // `REDISPATCH_COOLDOWN_MS`. The engine re-evaluates every 60 s and the desaturation is
    // still there, so without the cooldown every contact would be texted once a minute.
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    await advance(30_000);
    await waitFor(() => expect(screen.getByText('SENT')).toBeTruthy());
    await fireEvent.press(screen.getByText('Done'));

    await advance(60_000);
    await advance(60_000);

    expect(screen.queryByText('CRITICAL RISK DETECTED')).toBeNull();
    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(2); // the original two, and no more
  });
});

describe('the SOS button', () => {
  it('arms a manual alert with no rule reason attached', async () => {
    const screen = await renderFlow(HEALTHY, options({}));
    await waitFor(() => expect(screen.getByText('Emergency SOS')).toBeTruthy());

    await fireEvent.press(screen.getByText('Emergency SOS'));

    await waitFor(() => expect(screen.getByText('EMERGENCY SOS')).toBeTruthy());
    expect(screen.getByText('Alerting 2 contacts in 30s')).toBeTruthy();
    // No rule fired, so there is nothing to list — and inventing a reason would put a
    // diagnosis the engine never made into an emergency message.
    expect(screen.queryByText('· Blood oxygen critically low')).toBeNull();
  });

  it('sends a pressed alert saying so', async () => {
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      HEALTHY,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );
    await waitFor(() => expect(screen.getByText('Emergency SOS')).toBeTruthy());

    await fireEvent.press(screen.getByText('Emergency SOS'));
    await waitFor(() => expect(screen.getByText('EMERGENCY SOS')).toBeTruthy());
    await advance(30_000);

    await waitFor(() => expect(screen.getByText('SENT')).toBeTruthy());
    const body = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body)).message;
    expect(body).toContain('Reason: Emergency button pressed.');
  });
});

describe('the gates in front of sending', () => {
  it('refuses with nowhere to send, and says where to fix it', async () => {
    await AsyncStorage.clear();
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );

    await waitFor(() => expect(screen.getByText('NO CONTACTS')).toBeTruthy());
    expect(
      screen.getByText('Add an emergency contact in Settings so SOS has somewhere to send.'),
    ).toBeTruthy();
    // No countdown, because there is nothing a countdown could lead to.
    expect(screen.queryByText("Cancel — I'm OK")).toBeNull();
    await advance(30_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the user has turned SOS off', async () => {
    // PRD §7.2.6's consent gate, checked before contacts: a user who opted out should be told
    // they opted out, not told to add a contact.
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ contacts: CONTACTS, userName: 'Asha', sharing: { sos: false } }),
    );
    const fetchImpl = relay('ok');
    const screen = await renderFlow(
      DESATURATING,
      options({ dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } } }),
    );

    await waitFor(() => expect(screen.getByText('SOS IS OFF')).toBeTruthy());
    expect(screen.getByText('Emergency SOS is turned off')).toBeTruthy();
    await advance(30_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not report "no contacts" for a reading that fires before storage resolves', async () => {
    // The `loaded` gate. An empty contact list at mount means "not read yet", and treating it
    // as "the user has nobody" would refuse a genuine emergency for someone with three
    // contacts saved — then stay refused, because the refusal is terminal.
    const screen = await renderFlow(DESATURATING, options({}));

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    expect(screen.queryByText('NO CONTACTS')).toBeNull();
  });
});

describe('what the window promises about how it will send', () => {
  it('warns that the SMS app will open when no relay is configured', async () => {
    delete process.env.EXPO_PUBLIC_SOS_RELAY_URL;
    delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;

    const screen = await renderFlow(DESATURATING, options({}));

    await waitFor(() =>
      expect(
        screen.getByText(
          'No SOS relay configured — your SMS app will open with the message ready to send.',
        ),
      ).toBeTruthy(),
    );
  });

  it('says it sends by itself when a relay is configured', async () => {
    const screen = await renderFlow(DESATURATING, options({}));

    await waitFor(() =>
      expect(
        screen.getByText('Sends automatically. Your SMS app opens if the relay cannot be reached.'),
      ).toBeTruthy(),
    );
  });
});
