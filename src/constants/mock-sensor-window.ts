/**
 * A rolling sensor window synthesised from the demo constants in `health-data.ts`, so the
 * Dashboard can run the real Tier-1 risk engine (PRD §7.2.2) instead of showing hardcoded
 * card levels — paired with the **live** environment observation from PRD §7.2.3.
 *
 * ## What is still simulated and what is not
 * The vitals and motion window is simulated: PRD §7.2.1 sensor ingestion has not landed, so
 * there is no Health Connect or BLE buffer to read. The environment is no longer simulated —
 * `buildEnvironmentSnapshot` narrows a real OpenWeatherMap observation, fetched for the
 * device's coarse location, into the shape the engine consumes. The mock `ENVIRONMENT`
 * constant this used to read is gone.
 *
 * That split is why the file keeps its name: what remains mock here is the *sensor* window.
 *
 * ## Why this is a separate file
 * `health-data.ts` imports nothing, and that is load-bearing rather than incidental:
 * `src/risk/types.ts` takes three *types* from it and documents that as the engine's only
 * coupling to the app, which is what keeps the engine runtime-dependency-free and
 * unit-testable without a device. Putting a builder that imports `@/risk` into
 * `health-data.ts` would close that import into a cycle. So the demo values stay there and
 * the assembly happens here.
 *
 * ## Why a builder rather than a constant
 * Every duration rule in the engine compares timestamps against `now`, and the freshness
 * bounds are short — `window.maxStaleMs` is three minutes. A fixed array of epoch timestamps
 * would therefore be reported `stale` by every rule within minutes of being written, and the
 * demo would degrade into "no recent reading" cards. Anchoring the window to a
 * caller-supplied `now` keeps it fresh while staying a pure function, so tests can pin an
 * exact instant and get an exact assessment.
 *
 * When PRD §7.2.1 ingestion lands it replaces `buildMockReadings` with the real ring buffer;
 * the engine call site does not change.
 */

import { VITALS } from '@/constants/health-data';
import { toEnvironmentSnapshot, type LiveEnvironment } from '@/environment';
import type { EnvironmentSnapshot, MotionSummary, SensorReading } from '@/risk';

const SECOND = 1000;

/**
 * Spacing between synthetic readings. PRD §7.2.1 polls Health Connect every 30–60 s, and
 * testing at 1 Hz instead is what previously hid two thresholds that could never be
 * satisfied on real hardware, so the demo window uses the real cadence.
 */
const INTERVAL_MS = 60 * SECOND;

/**
 * How stale the newest reading is: half a polling interval, i.e. the ordinary state of a
 * buffer that is being polled every 60 s. Well inside `window.maxStaleMs` (3 min), so
 * every vitals category reports `dataQuality: 'ok'`.
 *
 * This value is not free to choose. PRD §7.2.5's collapse escalation needs a *trailing*
 * still run over `stillness.heatCriticalMs` (10 min), measured between readings inside
 * the engine's 12-minute extended lookback; the lookback's `maxGapMs` (2 min) of headroom
 * therefore has to cover both this lag and the half-open boundary's one-sample epsilon.
 * At a 60 s cadence that leaves the escalation reachable only while this stays **under**
 * 60 s — at exactly 60 s the achievable span is 10 min and the rule's `>` test fails.
 * `mock-sensor-window.test.ts` pins that boundary so the demo cannot drift into the
 * regime where a safety rule is silently unsatisfiable.
 */
const LATEST_AGE_MS = 30 * SECOND;

/**
 * Number of readings. The engine's longest lookback is
 * `stillness.heatCriticalMs + window.maxGapMs` = 12 min (PRD §7.2.5 needs to see ten
 * minutes of stillness *and* prove the readings were continuous), so the window has to
 * reach at least that far back or the extended-lookback rules silently see a short
 * buffer. Twenty one-minute samples reach 21 min, leaving real headroom.
 */
const SAMPLE_COUNT = 20;

/**
 * Accelerometer aggregates, in g with gravity included, in the two shapes the
 * stillness predicates actually distinguish.
 *
 * `ACTIVE` is not still because its *peak* exceeds `fall.stillnessPeakG` (1.4), not
 * because its mean is off — a walking user's mean magnitude sits near 1 g since gravity
 * dominates, which is exactly why the engine bounds the peak as well as the mean. It is
 * still far below `fall.impactG` (2.5), so it is movement, not an impact.
 */
const ACTIVE: MotionSummary = { peakG: 1.62, minG: 0.74, rmsG: 1.06, sampleCount: 60 };
const STILL: MotionSummary = { peakG: 1.04, minG: 0.97, rmsG: 1.0, sampleCount: 60 };

/**
 * A fall's motion signature, for the dev-only demo trigger (see {@link MockReadingOptions}).
 *
 * Both of `findImpacts`' clauses are cleared deliberately, because only one of them does real
 * work. `peakG` (3.1) is over `fall.impactG` (2.5), but `ACTIVE` above already shows why a peak
 * alone proves nothing: at this aggregation cadence `peakG` is a maximum over ~60 raw samples,
 * and `rules/fall.ts` documents that an ordinary pocket footstrike reaches the same 2–2.5 g as a
 * fall. The discriminator is `minG` (0.32), under `fall.freeFallMaxG` (0.65) — the near-weightless
 * phase that walking does not have. A demo sample that only raised the peak would be caught by
 * the free-fall clause and detect nothing, which is the correct behaviour and the reason this
 * constant carries both numbers rather than one.
 *
 * Every value stays inside `plausible.motionG` (0–32 g), so `motionEstimate` accepts the reading
 * instead of discarding it as implausible.
 */
const FALL_IMPACT: MotionSummary = { peakG: 3.1, minG: 0.32, rmsG: 1.12, sampleCount: 60 };

/**
 * Oldest → newest, one entry per reading. Values are ordinary and unremarkable on
 * purpose: any red card on the Dashboard should come from the environment, so that anyone
 * reading the output can tell a weather-driven flag apart from a physiological one.
 *
 * The series is deliberately *not* uniform. A constant series makes several distinct
 * bugs invisible — the newest sample coincides with the window's peak, so a rule that
 * scores off the wrong one still looks right — and that is precisely how a
 * flagged-but-green defect survived a green test suite earlier in this engine's life.
 */
const HR_BPM = [
  74, 76, 75, 77, 79, 81, 80, 77, 75, 76, 78, 80, 79, 77, 76, 78, 79, 77, 76, VITALS.hr,
];
const SPO2_PCT = [
  98, 97, 98, 97, 96, 97, 97, 98, 97, 96, 97, 98, 97, 97, 96, 97, 98, 97, 98, VITALS.spo2,
];
const SKIN_TEMP_C = [
  36.6, 36.7, 36.7, 36.8, 36.9, 36.9, 36.8, 36.7, 36.7, 36.8, 36.8, 36.9, 36.8, 36.8, 36.7, 36.8,
  36.9, 36.8, 36.7, VITALS.skinTempC,
];

/**
 * Sat down for a while, then got up.
 *
 * The trailing samples are `ACTIVE`, and that matters as soon as the weather is real. In
 * genuinely extreme heat — a NOAA Extreme Danger heat index — a *trailing* still run over
 * `stillness.heatCriticalMs` (10 min) satisfies PRD §7.2.5's "extreme heat index with no
 * motion for > 10 min", which fires `heat.stillness.critical` and makes the assessment an
 * SOS candidate. That is the correct reading of such data, which is the point: the demo
 * window describes a person moving about, not one who has collapsed. Flipping the tail to
 * `STILL` turns a hot day into an emergency, and `mock-sensor-window.test.ts` asserts both
 * directions — the escalation firing on a still tail is what proves the green fall card is a
 * real negative rather than an unreachable rule.
 *
 * The still stretch in the middle is 7 min of span. It is deliberately *not* trailing:
 * genuine stillness that the engine measures and reports, that correctly does not
 * escalate because the person has since got up.
 */
const MOTION: readonly MotionSummary[] = [
  ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE,
  STILL, STILL, STILL, STILL, STILL, STILL, STILL, STILL,
  ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE,
];

/**
 * The same window with a fall spliced into the tail, for the dev-only "Simulate Fall" control
 * on the Dashboard (see {@link MockReadingOptions}).
 *
 * Identical to `MOTION` except the last three samples become impact → still → still. At the
 * demo's 60 s cadence with the newest reading 30 s old, the impact lands at `now − 150 s` and
 * the two still readings at `now − 90 s` and `now − 30 s`. `rules/fall.ts` then finds the impact,
 * has `stillnessWindowMs` (130 s) of search space after it, measures a 60 s still run inside that
 * (over `stillnessMs`, 10 s) → *confirmed*, and — because the newest reading is still too —
 * reports the stillness as still *ongoing* → `SCORE_CRITICAL`, with `fall.impactThenStillness`
 * in `criticalRules`. That last flag is what makes the assessment an SOS candidate, so the demo
 * drives the countdown end-to-end through the real engine rather than faking the card.
 *
 * Two trailing still readings are the minimum: a single one spans zero milliseconds, which would
 * confirm the fall but leave `trailingStillRunMs` at 0, so the escalation to `SCORE_CRITICAL`
 * (and therefore the SOS) would not fire.
 */
const FALL_MOTION: readonly MotionSummary[] = [
  ...MOTION.slice(0, SAMPLE_COUNT - 3),
  FALL_IMPACT,
  STILL,
  STILL,
];

/**
 * Options for {@link buildMockReadings}.
 *
 * ## Why the demo trigger injects an *input* rather than setting an output
 * `simulateFall` exists so a fall can be **demonstrated** on a running app, and it deliberately
 * works at this layer: it changes the reading buffer the engine is handed, and nothing
 * downstream is told that anything unusual happened. `assessFall` finds the impact, measures the
 * stillness after it, and escalates on its own terms — the same code path a real accelerometer
 * would drive. A flag that forced the fall card red, or that pushed `fall.impactThenStillness`
 * into `criticalRules` directly, would demonstrate the *card* and prove nothing about the
 * detector. It would also be a live lie in the one direction that matters: the rule would look
 * reachable in a demo while being unreachable on hardware, which is precisely the failure class
 * this engine has repeatedly been dug out of.
 *
 * The Dashboard gates the affordance behind `__DEV__`, so it is absent from release builds.
 */
export type MockReadingOptions = {
  /** Splice an impact-then-stillness sequence into the tail of the window. See {@link FALL_MOTION}. */
  readonly simulateFall?: boolean;
};

/**
 * The demo's rolling sensor buffer, oldest → newest, as PRD §7.2.1's unified schema.
 *
 * @param now Evaluation instant in epoch ms. The newest reading lands
 *   `LATEST_AGE_MS` before it, so the window is fresh relative to whatever the caller
 *   is about to pass to `assessRisk`.
 * @param options Dev-only shaping of the window. Omitting it — the production call — yields
 *   exactly the window this file has always produced.
 */
export function buildMockReadings(now: number, options: MockReadingOptions = {}): SensorReading[] {
  const newest = now - LATEST_AGE_MS;
  const oldestIndex = SAMPLE_COUNT - 1;
  const motion = options.simulateFall === true ? FALL_MOTION : MOTION;

  return Array.from({ length: SAMPLE_COUNT }, (_unused, index) => ({
    source: 'simulated' as const,
    timestamp: newest - (oldestIndex - index) * INTERVAL_MS,
    hr: HR_BPM[index],
    spo2: SPO2_PCT[index],
    skinTempC: SKIN_TEMP_C[index],
    motionSummary: motion[index],
  }));
}

/**
 * The live weather observation, narrowed to what the engine consumes.
 *
 * The real adapter is `toEnvironmentSnapshot` in `@/environment`, which sits next to the
 * `LiveEnvironment` type it narrows and documents why each field is or is not forwarded.
 * This wrapper adds the one thing the engine call site needs on top of it: the feed is
 * asynchronous, so before the first response there is genuinely no observation, and the
 * engine takes `null` for that.
 *
 * `null` is not the same as an empty observation, and the difference is the whole point.
 * With `null` the engine reports `dataQuality: 'missing'` for the heat category and declines
 * to judge; a zero-filled snapshot would instead assert 0 °C at 0 % humidity and render a
 * confident green "heat conditions are comfortable" card built on nothing.
 *
 * @param environment The current observation, or null before the first successful fetch.
 */
export function buildEnvironmentSnapshot(
  environment: LiveEnvironment | null,
): EnvironmentSnapshot | null {
  return environment === null ? null : toEnvironmentSnapshot(environment);
}

/**
 * Demo mode's heat wave: the *weather* the engine is handed while "Simulate a heat wave" is
 * armed (workstream I1).
 *
 * ## Why two numbers and not a heat index
 * `EnvironmentSnapshot.heatIndexC` is a trusted-upstream override — supply one and the heat
 * rule stops computing and starts believing. That would be the heat equivalent of forcing the
 * fall card red: it would demonstrate the *card* and prove nothing about the rule. So the demo
 * injects only a dry-bulb temperature and a relative humidity, exactly the two fields a real
 * OpenWeatherMap observation contributes, and `rules/heat.ts` runs the NOAA regression over
 * them and bands the result itself. `mock-sensor-window.test.ts` asserts the resulting index
 * clears `HEAT_INDEX_BAND_MIN_F.extremeDanger` rather than restating the band here.
 *
 * ## Why 44 °C at 55 % RH
 * Both are ordinary readings for an Indian pre-monsoon heat wave (PS 26181's setting), which
 * matters: a demo that needed physically absurd weather to reach Extreme Danger would be
 * showing an unreachable rule. At 111.2 °F this also sits just past
 * `HEAT_INDEX_MAX_VALID_TEMP_F` (110), so the engine's own presentation guard marks the
 * category `partial` and prints the index as a floor ("Heat index over N°C") instead of a
 * number the NWS chart does not cover. That is the correct, honest rendering and it is pinned
 * by test — it is not a defect of the chosen values.
 */
export const DEMO_HEAT_WAVE_ENVIRONMENT = { tempC: 44, humidity: 55 } as const;

/**
 * The snapshot demo mode hands `assessRisk` in place of the live observation.
 *
 * Only the two heat fields are simulated. The AQI is carried through from the real observation
 * when the feed has produced one, so the respiratory card keeps describing the air the user is
 * actually breathing while the heat card describes the simulated weather — and is **omitted**
 * rather than zeroed when there is no observation yet, for the reason
 * {@link buildEnvironmentSnapshot} gives about `null`: an absent AQI makes the respiratory rule
 * decline to judge, while a `0` would have it assert clean air on nothing.
 *
 * `observedAt` is `now`, not the real observation's timestamp. A simulated reading is made at
 * the instant it is injected, and back-dating it to a real observation that may be 50 minutes
 * old would have `env.maxStaleMs` mark the demo stale partway through showing it.
 *
 * @param real The current live snapshot, or null before the first fetch — the only thing read
 *   from it is `aqi`.
 * @param now Evaluation instant in epoch ms.
 */
export function buildDemoHeatWaveSnapshot(
  real: EnvironmentSnapshot | null,
  now: number,
): EnvironmentSnapshot {
  const aqi = real?.aqi;
  return {
    tempC: DEMO_HEAT_WAVE_ENVIRONMENT.tempC,
    humidity: DEMO_HEAT_WAVE_ENVIRONMENT.humidity,
    ...(aqi === undefined ? {} : { aqi }),
    observedAt: now,
  };
}

/**
 * Live-mode counterpart of {@link FALL_MOTION}, for the same dev-only Dashboard control when
 * the buffer comes from Health Connect rather than from this file.
 *
 * Splices impact → still → still at `now − 2·INTERVAL`, `now − INTERVAL`, `now`, and strips
 * any live motion inside that span so a real "walking" summary cannot break the still run.
 * Every live *vital* is kept untouched — the point is to prove the detector on real data.
 *
 * The tail lands at exactly `now`, not `now − LATEST_AGE_MS` as the mock does, because
 * `rules/fall.ts` anchors the ongoing stillness on the newest *motion-bearing* reading
 * (motion-less HR samples are skipped). The live feed stamps its own motion reading at the
 * poll instant, which is the newest any live reading can be; a spliced tail any older would
 * be outranked by a live motion reading and the run would break there. So the tail is placed
 * at `now` — the poll instant — and live motion inside the span is stripped.
 */
export function spliceSimulatedFall(
  readings: readonly SensorReading[],
  now: number,
): SensorReading[] {
  const tail: SensorReading[] = [FALL_IMPACT, STILL, STILL].map((motionSummary, index) => ({
    source: 'simulated' as const,
    timestamp: now - (2 - index) * INTERVAL_MS,
    motionSummary,
  }));
  const spanStart = tail[0].timestamp;

  const kept: SensorReading[] = [];
  for (const reading of readings) {
    if (reading.timestamp < spanStart || reading.motionSummary === undefined) {
      kept.push(reading);
      continue;
    }
    // Inside the span: keep the vitals, drop the motion. A motion-only reading has nothing left.
    const vitals: SensorReading = { source: reading.source, timestamp: reading.timestamp };
    const stripped = {
      ...vitals,
      ...(reading.hr !== undefined ? { hr: reading.hr } : {}),
      ...(reading.spo2 !== undefined ? { spo2: reading.spo2 } : {}),
      ...(reading.skinTempC !== undefined ? { skinTempC: reading.skinTempC } : {}),
    };
    if (reading.hr !== undefined || reading.spo2 !== undefined || reading.skinTempC !== undefined) {
      kept.push(stripped);
    }
  }

  return [...kept, ...tail].sort((a, b) => a.timestamp - b.timestamp);
}

/** Exported for the tests that pin the demo's intended output. */
export const MOCK_WINDOW = {
  intervalMs: INTERVAL_MS,
  latestAgeMs: LATEST_AGE_MS,
  sampleCount: SAMPLE_COUNT,
  spanMs: (SAMPLE_COUNT - 1) * INTERVAL_MS,
  active: ACTIVE,
  still: STILL,
  /** The `simulateFall` impact sample, so its thresholds can be asserted against config. */
  fallImpact: FALL_IMPACT,
} as const;
