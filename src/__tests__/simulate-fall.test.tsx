/**
 * The dev-only "Simulate Fall" trigger, end to end.
 *
 * PRD §7.2.2's fall rule is the one Tier-1 flag that cannot be demonstrated by waiting: the
 * shipped demo window describes a person moving about, so the Fall Detection card is
 * permanently green and the escalation it feeds — PRD §7.2.5's SOS countdown — is never
 * reachable on a running app. `buildMockReadings`' `simulateFall` option exists to close that,
 * and this file is what makes the claim checkable rather than asserted.
 *
 * ## What is deliberately *not* mocked
 * The trigger works by handing the engine a different reading buffer, and nothing downstream is
 * told that anything unusual happened. So the interesting question is not "does the flag set a
 * flag" — it is whether `rules/fall.ts` independently finds the impact, measures the stillness
 * after it, and escalates on its own terms. Every test below therefore runs the real
 * `assessRisk`, and the two integration blocks run the real `HomeScreen`, `useSos`, `sosReducer`,
 * `composeSosMessage` and `SosAlert` on top of it. A trigger that forced the card red, or that
 * pushed `fall.impactThenStillness` into `criticalRules` directly, would pass a UI test and prove
 * nothing about the detector — and would be a lie in the one direction that matters, since the
 * rule would look reachable in a demo while being unreachable on hardware.
 *
 * The three blocks answer three different failure modes:
 *
 * 1. **The payload** — the injected sample clears *both* clauses `findImpacts` requires, and the
 *    engine reaches `SCORE_CRITICAL`. Includes the negative control: without the flag the same
 *    builder reports no fall, so the positive is a real positive.
 * 2. **The affordance** — pressing the button on the actual Dashboard turns the fall card red and
 *    opens the 30-second cancel window naming the fall and the contact.
 * 3. **The escalation** — letting that window close sends an alert whose reason, vitals and
 *    coordinates all trace back to the injected reading.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AlertsProvider } from '@/alerts/provider';
import { SosAlert } from '@/components/sos-alert';
import HomeScreen from '@/app/index';
import { buildMockReadings, MOCK_WINDOW, buildEnvironmentSnapshot } from '@/constants/mock-sensor-window';
import { fetchLiveEnvironment, readCachedEnvironment } from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { EnvironmentProvider } from '@/environment/provider';
import { useSos, type UseSosOptions } from '@/hooks/use-sos';
import { assessRisk, DEFAULT_RISK_THRESHOLDS, type SensorReading } from '@/risk';
import { SensorProvider } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';
import { ReadingStoreProvider } from '@/store/provider';
import { SETTINGS_KEY } from '@/settings/store';

// Only the network boundary is stubbed. The feed hook, provider, engine, screen, and SOS module
// are all the shipping code.
jest.mock('@/environment', () => ({
  ...jest.requireActual('@/environment'),
  fetchLiveEnvironment: jest.fn(),
  readCachedEnvironment: jest.fn(),
}));

const mockedFetch = fetchLiveEnvironment as jest.MockedFunction<typeof fetchLiveEnvironment>;
const mockedRead = readCachedEnvironment as jest.MockedFunction<typeof readCachedEnvironment>;

/** Frozen evaluation instant. Matches the other suites' anchor so numbers are comparable. */
const NOW = 1_766_000_000_000;

const T = DEFAULT_RISK_THRESHOLDS;

/** One contact, so the SOS consent gate has somewhere to send. Nothing is seeded by default. */
const MEERA = { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210' };

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// ---------------------------------------------------------------------------
// 1. The payload reaches the real fall rule
// ---------------------------------------------------------------------------

describe('the simulated impact is detected by the real fall rule', () => {
  const shipped = buildMockReadings(NOW);
  const injected = buildMockReadings(NOW, { simulateFall: true });

  it('leaves the production window byte-identical when the flag is absent', () => {
    // The one thing this option must never do is change the app's default behaviour. Both the
    // omitted and the explicitly-false call have to reproduce the window every other suite pins.
    expect(buildMockReadings(NOW, {})).toEqual(shipped);
    expect(buildMockReadings(NOW, { simulateFall: false })).toEqual(shipped);
    expect(shipped.slice(-3).map((reading) => reading.motionSummary)).toEqual([
      MOCK_WINDOW.active,
      MOCK_WINDOW.active,
      MOCK_WINDOW.active,
    ]);
  });

  it('changes only the tail motion, so nothing else can be causing the flag', () => {
    expect(injected).toHaveLength(shipped.length);
    expect(injected.slice(0, -3)).toEqual(shipped.slice(0, -3));
    expect(injected.slice(-3).map((reading) => reading.motionSummary)).toEqual([
      MOCK_WINDOW.fallImpact,
      MOCK_WINDOW.still,
      MOCK_WINDOW.still,
    ]);

    // Every vital is untouched, so a red fall card cannot be riding on a heart-rate excursion.
    expect(injected.map((r) => [r.timestamp, r.hr, r.spo2, r.skinTempC])).toEqual(
      shipped.map((r) => [r.timestamp, r.hr, r.spo2, r.skinTempC]),
    );
  });

  it('clears both of `findImpacts`’ clauses, not just the peak', () => {
    // `rules/fall.ts` documents why the peak alone is worthless at this aggregation cadence: an
    // ordinary pocket footstrike reaches the same 2–2.5 g. The free-fall minimum is the real
    // discriminator, so a demo sample that only raised the peak would correctly detect nothing.
    expect(MOCK_WINDOW.fallImpact.peakG).toBeGreaterThanOrEqual(T.fall.impactG);
    expect(MOCK_WINDOW.fallImpact.minG).toBeLessThanOrEqual(T.fall.freeFallMaxG);

    // And it stays inside the plausibility band, or `motionEstimate` discards the reading.
    expect(MOCK_WINDOW.fallImpact.peakG).toBeLessThanOrEqual(T.plausible.motionG.max);

    // The walking sample fails the first clause, which is why the shipped window is green.
    expect(MOCK_WINDOW.active.peakG).toBeLessThan(T.fall.impactG);
  });

  it('is scored as a confirmed, still-ongoing fall', () => {
    const fall = assessRisk({ readings: injected, now: NOW }).byCategory.fall;

    expect(fall.rule).toBe('fall.impactThenStillness');
    expect(fall.flagged).toBe(true);
    expect(fall.level).toBe('red');
    expect(fall.score).toBe(100);
    expect(fall.critical).toBe(true);

    // Composed inside `rules/fall.ts` from the injected sample and the timestamps around it.
    // Neither string appears in the fixture, so this cannot pass against a hardcoded metric.
    expect(fall.metric).toBe('Impact 3.1g, still 60s');
    expect(fall.tier).toBe('severe');
  });

  it('hands SOS the fall as a critical trigger', () => {
    const assessment = assessRisk({ readings: injected, now: NOW });

    expect(assessment.criticalRules).toContain('fall.impactThenStillness');
    expect(assessment.sosCandidate).toBe(true);
    expect(assessment.level).toBe('red');
  });

  it('reports no fall without the flag, so the detection is a reachable positive', () => {
    const assessment = assessRisk({ readings: shipped, now: NOW });

    expect(assessment.byCategory.fall.flagged).toBe(false);
    expect(assessment.byCategory.fall.metric).toBe('Active');
    expect(assessment.byCategory.fall.guidance).toBe('No fall or unusual stillness detected.');
    expect(assessment.criticalRules).toEqual([]);
    expect(assessment.sosCandidate).toBe(false);
  });

  it('does not smuggle the heat escalation in alongside the fall', () => {
    // The injected tail is *still*, and PRD §7.2.5's other critical trigger is extreme heat plus
    // no motion for over ten minutes. 60 s of stillness is far short of it. Asserted on the
    // hottest fixture available, because a demo that lit two emergencies at once would not be
    // demonstrating fall detection — and because it pins which rule the countdown will name.
    const assessment = assessRisk({
      readings: injected,
      environment: buildEnvironmentSnapshot(liveEnvironment()),
      now: NOW,
    });

    expect(assessment.criticalRules).toEqual(['fall.impactThenStillness']);
  });
});

// ---------------------------------------------------------------------------
// 2. The affordance on the real Dashboard
// ---------------------------------------------------------------------------

function renderHome() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <EnvironmentProvider>
        <SettingsProvider>
          {/* Memory store (the SQLite shim rejects under Jest). The simulated source never
              writes to it anyway — `use-sensors.test.ts` pins that. */}
          <ReadingStoreProvider>
            <SensorProvider>
              <AlertsProvider>
                <HomeScreen />
              </AlertsProvider>
            </SensorProvider>
          </ReadingStoreProvider>
        </SettingsProvider>
      </EnvironmentProvider>
    </SafeAreaProvider>,
  );
}

/**
 * `Date.now` frozen at `NOW` is doing two jobs here. It pins the engine's evaluation instant, so
 * the assessment is exact; and because `useSos` falls back to `Date.now` for its countdown clock,
 * it also holds the cancel window open indefinitely at 30 s. The interval still fires — this is
 * real timers — but every tick compares the same frozen instant against `firesAt`, so nothing
 * dispatches and no location or SMS boundary is reached. Block 3 steps over that boundary
 * deliberately, with the clock injected.
 */
describe('the Dashboard’s dev trigger drives fall detection and SOS', () => {
  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockedFetch.mockReset();
    mockedRead.mockReset();
    mockedRead.mockResolvedValue(null);
    // A mild day: 18 °C, clean air. Every other card is green, so anything red on screen after
    // the press came from the injected motion and nothing else.
    mockedFetch.mockResolvedValue(liveEnvironment({ tempC: 18, humidity: 55, aqi: 32 }));

    await AsyncStorage.clear();
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ contacts: [MEERA], userName: 'Asha' }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is present, labelled as instrumentation, and inert until pressed', async () => {
    const screen = await renderHome();

    expect(screen.getByText('Dev · Simulate a fall')).toBeTruthy();
    expect(
      screen.getByText(
        'Splices a real impact-then-stillness sequence into the sensor window so the fall rule fires and SOS escalates. Not present in release builds.',
      ),
    ).toBeTruthy();

    // Nothing has happened yet: the fall card is the engine's own green verdict, and the SOS
    // overlay is closed.
    expect(screen.getByText('No fall or unusual stillness detected.')).toBeTruthy();
    expect(screen.getAllByText('Normal')).toHaveLength(6);
    expect(screen.queryByText('CRITICAL RISK DETECTED')).toBeNull();
  });

  it('turns the fall card red with the engine’s own guidance and metric', async () => {
    const screen = await renderHome();

    await fireEvent.press(screen.getByText('Dev · Simulate a fall'));

    // Both strings are built inside the engine — the headline by `recommend()` selecting the
    // ladder's 90-rung from a score of 100, the metric by `assessFall` formatting the impact it
    // found and the stillness it measured.
    await waitFor(() =>
      expect(
        screen.getByText(
          'A fall was detected and you have not moved since — help may be needed.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('Impact 3.1g, still 60s')).toBeTruthy();

    // Exactly one card changed. On an 18 °C day nothing else has any reason to.
    expect(screen.getAllByText('Alert')).toHaveLength(1);
    expect(screen.getAllByText('Normal')).toHaveLength(5);
  });

  it('opens the 30-second cancel window naming the fall and the contact', async () => {
    const screen = await renderHome();

    // The SOS gate needs the settings load to have landed; before it does, the machine reports
    // `no_contacts` instead of arming. The button copy is the observable signal.
    await waitFor(() =>
      expect(screen.getByText(/^Alerts your contact with your location/)).toBeTruthy(),
    );

    await fireEvent.press(screen.getByText('Dev · Simulate a fall'));

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());

    // 30 whole seconds, PRD §7.2.5. Read through the accessibility label, because the digit on
    // its own is a bare number that would match anything.
    expect(screen.getByLabelText('30 seconds to cancel')).toBeTruthy();
    expect(screen.getByText('Alerting 1 contact in 30s')).toBeTruthy();
    // Verbatim from the same table the outgoing SMS uses, so what is on screen during the window
    // is what the contact will read — and it says *fall*, not a generic critical alert.
    expect(screen.getByText('· Possible fall, no movement since')).toBeTruthy();
    // Who it will reach, before it reaches them.
    expect(screen.getByText('Meera · +91 98765 43210')).toBeTruthy();
    expect(screen.getByText("Cancel — I'm OK")).toBeTruthy();
  });

  it('clears back to a green fall card, so the demo can be re-run', async () => {
    const screen = await renderHome();

    await fireEvent.press(screen.getByText('Dev · Simulate a fall'));
    await waitFor(() => expect(screen.getByText('Impact 3.1g, still 60s')).toBeTruthy());

    await fireEvent.press(screen.getByText("Cancel — I'm OK"));
    await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy());
    await fireEvent.press(screen.getByText('Done'));
    await fireEvent.press(screen.getByText('Clear simulated fall'));

    await waitFor(() =>
      expect(screen.getByText('No fall or unusual stillness detected.')).toBeTruthy(),
    );
    expect(screen.queryByText('Impact 3.1g, still 60s')).toBeNull();
    expect(screen.getByText('Dev · Simulate a fall')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. Letting the window close: what the contact actually receives
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://phc-1234.twil.io/sos';
const originalRelay = process.env.EXPO_PUBLIC_SOS_RELAY_URL;

const FIX = {
  ok: true as const,
  location: { latitude: 13.0827, longitude: 80.2707, accuracyM: 12, timestamp: NOW },
};

/** Mutable wall clock, injected. Advanced only by `advance`, so ticks stay observable. */
let clock = NOW;

/**
 * The Dashboard calls `useSos` with no options, so the two process boundaries — the location fix
 * and the network — cannot be injected through the screen. This harness is the Dashboard's call
 * site with those two stubbed, fed the *same* window the button produces, so the countdown can be
 * driven past its 30 s without the test process needing a GPS or a Twilio account.
 */
function Harness({ readings, options }: { readings: readonly SensorReading[]; options: UseSosOptions }) {
  const assessment = useMemo(() => assessRisk({ readings, now: NOW }), [readings]);
  const sos = useSos({ assessment, latest: readings[readings.length - 1] ?? null }, options);
  return <SosAlert controller={sos} />;
}

async function advance(ms: number) {
  clock += ms;
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** A `fetch` standing in for the emergency relay, delivering to every contact by SMS gateway. */
function relay() {
  return jest.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ results: [{ channel: 'textbelt', ok: true }], delivered: true }),
      }) as unknown as Response,
  ) as unknown as typeof fetch;
}

describe('the simulated fall’s alert reaches a contact with a location', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    clock = NOW;
    await AsyncStorage.clear();
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ contacts: [MEERA], userName: 'Asha' }),
    );
    process.env.EXPO_PUBLIC_SOS_RELAY_URL = ENDPOINT;
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalRelay === undefined) delete process.env.EXPO_PUBLIC_SOS_RELAY_URL;
    else process.env.EXPO_PUBLIC_SOS_RELAY_URL = originalRelay;
  });

  it('sends the fall reason, the injected vitals, and the resolved coordinates', async () => {
    const fetchImpl = relay();
    const screen = await render(
      <SettingsProvider>
        <Harness
          readings={buildMockReadings(NOW, { simulateFall: true })}
          options={{
            nowImpl: () => clock,
            resolveLocationImpl: () => Promise.resolve(FIX),
            vibrateImpl: jest.fn(),
            cancelVibrationImpl: jest.fn(),
            dispatchOptions: { relay: { endpoint: ENDPOINT, fetchImpl } },
          }}
        />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    expect(fetchImpl).not.toHaveBeenCalled();

    await advance(30_000);

    await waitFor(() => expect(screen.getByText('SENT')).toBeTruthy());

    const calls = (fetchImpl as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body)).to).toEqual({ phone: '+919876543210' });

    // The whole chain in one assertion: injected reading → engine → machine → location →
    // composer → relay. The name comes from settings, the reason from the engine's
    // `criticalRules`, the vitals from the newest injected reading, the coordinates from the
    // resolver.
    const sent = JSON.parse(String(calls[0][1]?.body)).message as string;
    expect(sent).toContain('RAKSHA EMERGENCY - Asha needs help.');
    expect(sent).toContain('Reason: Possible fall, no movement since.');
    expect(sent).toContain('Vitals: HR 78 bpm, SpO2 97%, skin 36.8C');
    expect(sent).toContain('Location: 13.082700, 80.270700 (+/-12m)');

    // And the same text is shown back to the user, so they can see what was sent on their behalf.
    expect(screen.getByText(sent)).toBeTruthy();
  });
});
