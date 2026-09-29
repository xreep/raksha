/**
 * The one line that decides whether the Dashboard scores real or simulated data.
 *
 * Everything else in this hook is a memo over pure functions that have their own tests. What
 * has to be pinned here is the *selection*: with the picker on Health Connect the engine must
 * see the feed's buffer and not the mock, with it on simulated it must see the mock and never
 * the feed, and the dev-only fall splice must work on both. A hook that silently kept reading
 * the mock would pass every other test in the repository.
 */

import { renderHook } from '@testing-library/react-native';

import { buildMockReadings } from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import type { SensorReading } from '@/risk';
import { useSensorFeed } from '@/sensors/provider';
import { useSettings } from '@/settings/provider';
import { DEFAULT_SETTINGS } from '@/settings/store';

jest.mock('@/environment/provider', () => ({ useEnvironmentFeed: jest.fn() }));
jest.mock('@/sensors/provider', () => ({ useSensorFeed: jest.fn() }));
jest.mock('@/settings/provider', () => ({ useSettings: jest.fn() }));

const environment = jest.mocked(useEnvironmentFeed);
const feed = jest.mocked(useSensorFeed);
const settings = jest.mocked(useSettings);

const NOW = 1_766_000_000_000;
const requestAccess = jest.fn();

const STILL = { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount: 1500 };

function liveReading(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, hr: bpm };
}

function liveAt(offsetMs: number, fields: Partial<SensorReading>): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, ...fields };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  environment.mockReturnValue({
    environment: null,
    status: 'loading',
    failure: null,
    refreshing: false,
    refresh: jest.fn(),
  });
  feed.mockReturnValue({
    readings: [liveReading(-30_000, 131)],
    status: 'live',
    failure: null,
    storeFailure: null,
    lastPolledAt: NOW,
    requestAccess,
    refresh: jest.fn(),
  });
  settings.mockReturnValue({
    settings: { ...DEFAULT_SETTINGS, sensorSource: 'health_connect' },
    loaded: true,
    writeFailed: false,
    addContact: jest.fn(),
    removeContact: jest.fn(),
    setUserName: jest.fn(),
    setSharing: jest.fn(),
    setSensorSource: jest.fn(),
    setProfile: jest.fn(),
    setAlertsEnabled: jest.fn(),
    setDemoMode: jest.fn(),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRiskAssessment source selection', () => {
  it('scores the live buffer when the source is health_connect', async () => {
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(true);
    expect(result.current.latest?.source).toBe('health_connect');
    expect(result.current.latest?.hr).toBe(131);
    expect(result.current.feedStatus).toBe('live');
    expect(result.current.requestAccess).toBe(requestAccess);
  });

  it('scores the simulated window when the source is simulated, ignoring the feed', async () => {
    settings.mockReturnValue({
      ...settings(),
      settings: { ...DEFAULT_SETTINGS, sensorSource: 'simulated' },
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(false);
    expect(result.current.latest).toEqual(buildMockReadings(NOW).at(-1));
    expect(result.current.assessment.sampleCount).toBeGreaterThan(1);
  });

  it('reports an empty live buffer as no latest reading rather than falling back to the mock', async () => {
    feed.mockReturnValue({ ...feed(), readings: [] });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest).toBeNull();
    expect(result.current.assessment.sampleCount).toBe(0);
  });

  it('composes latestVitals from the newest of each vital, not from the motion-only tail', async () => {
    // The live shape: HR and SpO₂ from the band, then the phone's motion summary stamped at the
    // poll instant. `latest` is that motion-only reading (the fall rule anchors on it); the SOS
    // message must still quote the vitals that are 30–45 s old.
    feed.mockReturnValue({
      ...feed(),
      readings: [
        liveAt(-30_000, { hr: 88 }),
        liveAt(-45_000, { spo2: 95 }),
        liveAt(0, { motionSummary: STILL }),
      ],
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest?.motionSummary).toBeDefined();
    expect(result.current.latest?.hr).toBeUndefined();
    expect(result.current.latestVitals?.hr).toBe(88);
    expect(result.current.latestVitals?.spo2).toBe(95);
    expect(result.current.latestVitals?.skinTempC).toBeUndefined();
    expect(result.current.latestVitals?.timestamp).toBe(NOW - 30_000);
  });

  it('reports no latestVitals and a zero vital count when only motion has arrived', async () => {
    feed.mockReturnValue({ ...feed(), readings: [liveAt(0, { motionSummary: STILL })] });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest).not.toBeNull();
    expect(result.current.latestVitals).toBeNull();
    // `assessment.sampleCount` is 1 here; the Dashboard's "waiting" notice keys off this.
    expect(result.current.assessment.sampleCount).toBe(1);
    expect(result.current.vitalReadingCount).toBe(0);
  });

  it('counts only readings that carry at least one vital', async () => {
    feed.mockReturnValue({
      ...feed(),
      readings: [
        liveAt(-90_000, { hr: 70, spo2: 98 }),
        liveAt(-60_000, { motionSummary: STILL }),
        liveAt(-30_000, { skinTempC: 36.5 }),
        liveAt(0, { motionSummary: STILL }),
      ],
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.vitalReadingCount).toBe(2);
  });

  it('agrees latest and latestVitals on the simulated window, whose every reading carries all vitals', async () => {
    settings.mockReturnValue({
      ...settings(),
      settings: { ...DEFAULT_SETTINGS, sensorSource: 'simulated' },
    });
    const { result } = await renderHook(() => useRiskAssessment());
    const newest = buildMockReadings(NOW).at(-1);
    expect(result.current.latestVitals).toMatchObject({
      hr: newest?.hr,
      spo2: newest?.spo2,
      skinTempC: newest?.skinTempC,
      timestamp: newest?.timestamp,
    });
  });

  it('evaluates at the poll instant when the feed polled after the last clock tick', async () => {
    // `useNow` ticks on its own 60 s timer; the feed stamps its motion reading at its own
    // `Date.now()`. A poll landing after the tick (first poll, AppState catch-up, refresh)
    // would otherwise be `timestamp > now` and dropped by `withinWindow` until the next tick —
    // doubling fall-detection latency.
    feed.mockReturnValue({
      ...feed(),
      readings: [liveReading(-30_000, 76), liveAt(10_000, { motionSummary: STILL })],
      lastPolledAt: NOW + 10_000,
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.assessment.evaluatedAt).toBe(NOW + 10_000);
    expect(result.current.assessment.sampleCount).toBe(2);
  });

  it('evaluates at the clock tick when the feed has not polled', async () => {
    feed.mockReturnValue({ ...feed(), readings: [], lastPolledAt: null });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.assessment.evaluatedAt).toBe(NOW);
  });

  it('never evaluates earlier than the clock tick because of an older poll', async () => {
    feed.mockReturnValue({ ...feed(), lastPolledAt: NOW - 45_000 });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.assessment.evaluatedAt).toBe(NOW);
  });

  it('splices the simulated fall onto the live buffer under simulateFall', async () => {
    const { result } = await renderHook(() => useRiskAssessment({ simulateFall: true }));
    expect(result.current.live).toBe(true);
    expect(result.current.assessment.byCategory.fall.criticalRules).toContain(
      'fall.impactThenStillness',
    );
    expect(result.current.assessment.sosCandidate).toBe(true);
  });
});

/**
 * `simulateHeatWave` (workstream I1) is the environment-side twin of `simulateFall`, and the
 * question it has to answer is the same one: does it change the engine's *input* and leave
 * everything downstream to decide for itself?
 *
 * So the first test here is the negative control — with the option off, absent, or explicitly
 * false, the hook's output has to be byte-identical to what it produced before this option
 * existed. An option that silently perturbed the default path would be a live lie in a health
 * app, and it is the failure no test of the armed path can catch.
 */
describe('useRiskAssessment simulateHeatWave', () => {
  const REAL_WEATHER = {
    location: 'Chennai',
    coordinates: { latitude: 13.08, longitude: 80.27 },
    locationSource: 'device' as const,
    observedAt: NOW - 12 * 60 * 1000,
    fetchedAt: NOW - 12 * 60 * 1000,
    tempC: 24,
    humidity: 48,
    heatIndexC: null,
    heatIndexBand: null,
    aqi: 168,
    aqiCategory: null,
    aqiBasis: null,
    pollutants: {},
    advisories: [],
  };

  function withRealWeather() {
    environment.mockReturnValue({
      environment: REAL_WEATHER,
      status: 'live',
      failure: null,
      refreshing: false,
      refresh: jest.fn(),
    });
  }

  it('leaves the default path byte-identical when the option is off', async () => {
    withRealWeather();

    const before = (await renderHook(() => useRiskAssessment())).result.current.assessment;
    const omitted = (await renderHook(() => useRiskAssessment({}))).result.current.assessment;
    const explicit = (await renderHook(() => useRiskAssessment({ simulateHeatWave: false })))
      .result.current.assessment;

    expect(omitted).toEqual(before);
    expect(explicit).toEqual(before);
    // And the baseline really is a cool day, or "unchanged" would be unfalsifiable.
    expect(before.byCategory.heat.firedRules).toEqual([]);
    expect(before.byCategory.heat.level).toBe('green');
  });

  it('swaps the environment snapshot so the real heat rule reaches Extreme Danger', async () => {
    withRealWeather();

    const { result } = await renderHook(() => useRiskAssessment({ simulateHeatWave: true }));

    // The rule id, not a colour: Danger is red too, so a colour assertion would pass on the
    // wrong band. This id is pushed by `rules/heat.ts` off an index it computed itself from the
    // two demo numbers.
    expect(result.current.assessment.byCategory.heat.firedRules).toContain(
      'heat.index.extremeDanger',
    );
  });

  it('keeps the real AQI, so only the weather half of the environment is simulated', async () => {
    withRealWeather();

    const { result } = await renderHook(() => useRiskAssessment({ simulateHeatWave: true }));

    // 168 is the real observation's AQI. The respiratory card is still describing the air the
    // user is actually breathing — `rules/respiratory.ts`'s own advisory precursor is the
    // observable proof that the number survived the swap.
    expect(result.current.assessment.byCategory.respiratory.firedRules.join(' ')).toContain(
      'respiratory.aqi',
    );
  });

  it('does not touch the readings, so an armed heat wave cannot fabricate a vital', async () => {
    withRealWeather();

    const plain = (await renderHook(() => useRiskAssessment())).result.current;
    const armed = (await renderHook(() => useRiskAssessment({ simulateHeatWave: true })))
      .result.current;

    expect(armed.latest).toEqual(plain.latest);
    expect(armed.latestVitals).toEqual(plain.latestVitals);
    expect(armed.vitalReadingCount).toBe(plain.vitalReadingCount);
  });

  it('composes with simulateFall without either option swallowing the other', async () => {
    withRealWeather();

    const { result } = await renderHook(() =>
      useRiskAssessment({ simulateFall: true, simulateHeatWave: true }),
    );
    const { assessment } = result.current;

    expect(assessment.byCategory.heat.firedRules).toContain('heat.index.extremeDanger');
    expect(assessment.byCategory.fall.criticalRules).toContain('fall.impactThenStillness');
    // Extreme heat plus a *60-second* still run is not PRD §7.2.5's collapse (it needs ten
    // trailing minutes), so the countdown still names the fall and only the fall.
    expect(assessment.criticalRules).toEqual(['fall.impactThenStillness']);
  });

  it('simulates the weather even before the live feed has produced an observation', async () => {
    // `environment` is null in the file-level default. The demo must still work at cold start —
    // and the AQI is simply absent rather than invented.
    const { result } = await renderHook(() => useRiskAssessment({ simulateHeatWave: true }));

    expect(result.current.assessment.byCategory.heat.firedRules).toContain(
      'heat.index.extremeDanger',
    );
    expect(result.current.assessment.byCategory.heat.dataQuality).not.toBe('stale');
  });
});
