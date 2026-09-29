/**
 * Pins the demo sensor window and the assessment the Dashboard renders from it.
 *
 * Three jobs. The first is ordinary regression cover: the Home screen's cards are now
 * computed, so the values a reviewer sees on screen are only trustworthy if something
 * asserts what the engine returns for this fixture.
 *
 * The second matters more. A fixture that produces four plausible cards can still be
 * wrong in the way this engine has been wrong four times already — a threshold that is
 * unsatisfiable given the sampling cadence or the window shape, failing silently, with a
 * green card over a real event and a green test suite over the lot. A green `fall` card
 * proves nothing on its own; it has to be shown to be a *reachable* negative. So the
 * escalation this fixture is built to avoid is asserted to fire when the motion that
 * suppresses it is removed, and the freshness margin that keeps it reachable is asserted
 * directly.
 *
 * The third is new with the live environment feed. The weather half of this window is no
 * longer a constant: `buildEnvironmentSnapshot` narrows a real OpenWeatherMap observation.
 * That introduces one more member of the same silent-failure family — an AQI arriving on the
 * provider's 1–5 scale instead of the 0–500 scale the thresholds are written against — so the
 * consequence of getting it wrong is asserted here, at the engine, rather than only at the
 * fetch boundary.
 */

import { VITALS } from '@/constants/health-data';
import {
  buildDemoHeatWaveSnapshot,
  buildEnvironmentSnapshot,
  buildMockReadings,
  DEMO_HEAT_WAVE_ENVIRONMENT,
  MOCK_WINDOW,
  spliceSimulatedFall,
} from '@/constants/mock-sensor-window';
import { FIXTURE_OBSERVATION_AGE_MS, liveEnvironment } from '@/environment/__tests__/fixtures';
import {
  assessRisk,
  computeVitalBaselines,
  computeHeatIndexF,
  celsiusToFahrenheit,
  DEFAULT_RISK_THRESHOLDS as T,
  HEAT_INDEX_BAND_MIN_F,
} from '@/risk';
import type { SensorReading } from '@/risk';

/** Fixed instant, so every expectation below is exact. Matches the fixture's `FIXTURE_NOW`. */
const NOW = 1_766_000_000_000;

/**
 * The observation the Dashboard would be holding: 38 °C at 62 % RH with an EPA AQI of 168,
 * which are the conditions the retired `ENVIRONMENT` constant described. They are now test
 * input rather than something the app ships, and the fixture *derives* the heat index from
 * them, so the three numbers cannot drift apart.
 */
const LIVE = liveEnvironment();

const readings = buildMockReadings(NOW);
const environment = buildEnvironmentSnapshot(LIVE);
const assessment = assessRisk({ readings, environment, now: NOW });

const newest = readings[readings.length - 1];

describe('mock sensor window', () => {
  it('is a pure function of `now`', () => {
    expect(buildMockReadings(NOW)).toEqual(readings);

    // Shifting the anchor shifts every timestamp by the same amount and changes nothing
    // else — the fixture carries no hidden clock read.
    const shifted = buildMockReadings(NOW + 5_000);
    expect(shifted.map((r) => r.timestamp)).toEqual(readings.map((r) => r.timestamp + 5_000));
    expect(shifted.map((r) => ({ ...r, timestamp: 0 }))).toEqual(
      readings.map((r) => ({ ...r, timestamp: 0 })),
    );
  });

  it('is ordered oldest → newest with no gap the engine would treat as a break', () => {
    for (let i = 1; i < readings.length; i += 1) {
      const gap = readings[i].timestamp - readings[i - 1].timestamp;
      expect(gap).toBe(MOCK_WINDOW.intervalMs);
      expect(gap).toBeLessThanOrEqual(T.window.maxGapMs);
    }
  });

  it('reaches back past the engine’s longest lookback', () => {
    // `assess.ts` clamps to the widest span any rule needs. A window shorter than that
    // leaves the extended-lookback rules quietly reading a truncated buffer rather than
    // erroring — which is why this is asserted here and not left to arithmetic in a comment.
    // The bound is currently set by `fatigue.windowMs`, not by the heat escalation, so a
    // reviewer widening either advisory window will be told by this test that the demo
    // buffer has to grow with it.
    const longestLookbackMs = Math.max(
      T.window.ms,
      T.stillness.heatCriticalMs + T.window.maxGapMs,
      T.fall.stillnessWindowMs,
      T.dehydration.windowMs,
      T.fatigue.windowMs,
    );
    expect(NOW - readings[0].timestamp).toBeGreaterThan(longestLookbackMs);
  });

  it('keeps the newest reading fresh enough for every rule to be reachable', () => {
    expect(NOW - newest.timestamp).toBe(MOCK_WINDOW.latestAgeMs);
    expect(MOCK_WINDOW.latestAgeMs).toBeLessThan(T.window.maxStaleMs);

    // The binding constraint, and the reason this is not simply "under maxStaleMs":
    // the extended lookback's `maxGapMs` headroom has to cover both this lag and the
    // half-open boundary's one-sample epsilon, so at this cadence a lag of a full
    // interval makes PRD §7.2.5's collapse escalation unsatisfiable. See the escalation
    // test below, which is what actually proves it is still reachable.
    expect(MOCK_WINDOW.latestAgeMs).toBeLessThan(MOCK_WINDOW.intervalMs);
  });

  it('ends on the vitals the Dashboard shows', () => {
    expect(newest.hr).toBe(VITALS.hr);
    expect(newest.spo2).toBe(VITALS.spo2);
    expect(newest.skinTempC).toBe(VITALS.skinTempC);
    expect(newest.source).toBe('simulated');
  });

  it('does not vary a vital by so little that a peak-vs-newest mix-up would hide', () => {
    // A constant series makes several distinct rule bugs invisible, because the newest
    // sample and the window's extreme coincide.
    const hrValues = readings.map((r) => r.hr as number);
    expect(Math.max(...hrValues)).toBeGreaterThan(Math.min(...hrValues));
    expect(Math.max(...hrValues)).toBeGreaterThan(newest.hr as number);
  });
});

describe('the live environment the window is paired with', () => {
  it('forwards only the measurements the engine consumes', () => {
    expect(environment).toEqual({
      tempC: LIVE.tempC,
      humidity: LIVE.humidity,
      aqi: LIVE.aqi,
      observedAt: NOW - FIXTURE_OBSERVATION_AGE_MS,
    });
    expect(FIXTURE_OBSERVATION_AGE_MS).toBeLessThan(T.env.maxStaleMs);
  });

  it('narrows nothing when there is no observation yet', () => {
    // The feed is asynchronous, so before the first response there genuinely is no weather,
    // and `null` is the only honest input.
    expect(buildEnvironmentSnapshot(null)).toBeNull();
  });

  it('declines to judge heat rather than reporting comfortable conditions', () => {
    const blind = assessRisk({ readings, environment: null, now: NOW });
    const heat = blind.byCategory.heat;

    // A zero-filled snapshot would instead assert 0 °C at 0 % humidity and render a
    // confident green "comfortable" card built on nothing at all. `level` is green either
    // way — it is the only level available — so `dataQuality` carries the whole difference.
    expect(heat.dataQuality).toBe('missing');
    expect(heat.flagged).toBe(false);
    expect(blind.heatIndexC).toBeNull();
    expect(heat.metric).toBe('Heat index —');
    expect(heat.guidance).not.toMatch(/comfortable|normal range/i);
  });
});

describe('the AQI scale reaching the engine', () => {
  /** The reported respiratory multiplier for a given AQI, all else held equal. */
  function multiplierFor(aqi: number | null) {
    return assessRisk({
      readings,
      environment: buildEnvironmentSnapshot(liveEnvironment({ aqi })),
      now: NOW,
    }).byCategory.respiratory.envMultiplier;
  }

  it('amplifies on the 0–500 scale the thresholds are written against', () => {
    // 168 → (168 − 100) / (300 − 100) × (1.3 − 1) + 1.
    expect(multiplierFor(168)).toBeCloseTo(1.102, 3);
  });

  it('would silently stop amplifying if the provider’s 1–5 band were forwarded raw', () => {
    // This is the failure the EPA computation in `@/environment` exists to prevent, asserted
    // at the place it would actually be felt. OpenWeatherMap reports the same dirty air as
    // `main.aqi: 4`, and `respiratory.ts`'s `aqi <= env.aqiNeutralBelow` is then permanently
    // true — no throw, no log, no failing test, and PRD §7.2.3's environmental amplification
    // simply never happens. Pinning both numbers is what makes the regression loud.
    expect(multiplierFor(4)).toBe(1);
    expect(multiplierFor(4)).toBeLessThan(multiplierFor(168));
  });

  it('does not amplify when air quality is missing, rather than treating it as clean', () => {
    expect(multiplierFor(null)).toBe(1);
  });
});

describe('the assessment the Dashboard renders', () => {
  it('is red overall, driven by heat, and is not an SOS candidate', () => {
    expect(assessment.level).toBe('red');
    expect(assessment.flaggedRules).toEqual(['heat.index.extremeDanger']);
    expect(assessment.criticalRules).toEqual([]);
    expect(assessment.sosCandidate).toBe(false);
  });

  it('evaluated a usable number of samples, so no category is guessing', () => {
    expect(assessment.sampleCount).toBeGreaterThanOrEqual(T.window.minSamples);
    for (const category of assessment.categories) {
      expect(category.dataQuality).toBe('ok');
    }
  });

  it('bands the heat index against NOAA', () => {
    // The engine derives its own heat index from `tempC` and `humidity`; the snapshot
    // deliberately does not carry one. Equality with the observation's is the property that
    // makes the omission safe — `service.test.ts` asserts the same thing end to end.
    expect(assessment.heatIndexC).toBe(LIVE.heatIndexC);
    expect(assessment.heatIndexBand?.label).toBe('Extreme Danger');
    expect(assessment.heatIndexOutOfDomain).toBe(false);
  });

  it('produces the six cards in dashboard order', () => {
    expect(assessment.categories.map((c) => c.key)).toEqual([
      'heat',
      'respiratory',
      'cardiovascular',
      'fall',
      'dehydration',
      'fatigue',
    ]);

    expect(
      assessment.categories.map((c) => ({
        key: c.key,
        level: c.level,
        flagged: c.flagged,
        rule: c.rule,
        metric: c.metric,
        guidance: c.guidance,
      })),
    ).toEqual([
      {
        key: 'heat',
        level: 'red',
        flagged: true,
        rule: 'heat.index.extremeDanger',
        metric: 'Heat index 56°C',
        guidance: 'Extreme heat danger — get indoors or into shade and cool down now.',
      },
      {
        // Amber on the *air*, not the blood oxygen: the observation's AQI of 168 is EPA
        // "Unhealthy", which is the respiratory advisory precursor (PS 26181 §3b). Not a
        // flag — `flagged` stays false and SpO₂ 97 % is normal — and the metric line carries
        // both numbers so a reader can see which one moved the card.
        key: 'respiratory',
        level: 'amber',
        flagged: false,
        rule: 'respiratory.aqi.unhealthy',
        metric: 'SpO₂ 97% · AQI 168 (Unhealthy)',
        guidance:
          'Air quality is unhealthy — limit prolonged outdoor exertion and keep windows closed.',
      },
      {
        key: 'cardiovascular',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR 78 bpm',
        guidance: 'Resting heart rate looks normal.',
      },
      {
        key: 'fall',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'Active',
        guidance: 'No fall or unusual stillness detected.',
      },
      {
        // Extreme heat *without* cardiovascular drift. This is the pair that shows the
        // dehydration rule is a conjunction and not a second heat card: the heat index here
        // is 56 °C, far past the exposure threshold, and the card is still green because the
        // heart rate has not moved off its own baseline. The escalation block below asserts
        // the reachable positive.
        key: 'dehydration',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR +0 bpm vs baseline 78',
        guidance: 'Heat exposure is high but your heart rate is steady — keep drinking water.',
      },
      {
        key: 'fatigue',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR 78 bpm, active',
        guidance: 'No signs of fatigue.',
      },
    ]);
  });

  it('scores heat in the red band, respiratory at the air-quality advisory, and the rest at zero', () => {
    expect(assessment.byCategory.heat.score).toBeGreaterThanOrEqual(90);
    // The advisory's configured amber score, not a multiplied SpO₂ score: SpO₂ 97 % scores 0
    // on its own, and `envMultiplier` is still reported rather than applied.
    expect(assessment.byCategory.respiratory.score).toBe(T.env.aqiUnhealthyScore);
    expect(assessment.byCategory.respiratory.flagged).toBe(false);
    expect(assessment.byCategory.cardiovascular.score).toBe(0);
    expect(assessment.byCategory.fall.score).toBe(0);
    expect(assessment.byCategory.dehydration.score).toBe(0);
    expect(assessment.byCategory.fatigue.score).toBe(0);
  });
});

describe('the escalation this fixture is built to avoid', () => {
  /** The same window with the movement removed — a person who has not stirred. */
  const stillWindow: SensorReading[] = buildMockReadings(NOW).map((reading) => ({
    ...reading,
    motionSummary: MOCK_WINDOW.still,
  }));

  const collapsed = assessRisk({ readings: stillWindow, environment, now: NOW });

  it('fires once the trailing movement is gone, so the green fall card is a real negative', () => {
    expect(collapsed.criticalRules).toContain('heat.stillness.critical');
    expect(collapsed.sosCandidate).toBe(true);
    expect(collapsed.byCategory.heat.critical).toBe(true);
    expect(collapsed.byCategory.heat.guidance).toBe(
      'Extreme heat and no movement detected — this may be heat collapse.',
    );
  });

  it('is suppressed in the shipped fixture only because the user is moving now', () => {
    // Same heat, same environment, same vitals — the trailing motion is the only
    // difference, which is what makes this pair a control rather than two unrelated runs.
    expect(assessment.byCategory.heat.rule).toBe('heat.index.extremeDanger');
    expect(collapsed.byCategory.heat.rule).toBe('heat.stillness.critical');
    expect(assessment.byCategory.heat.metric).toBe(collapsed.byCategory.heat.metric);
  });

  it('still reports no fall, because stillness alone is not a fall', () => {
    // PRD §7.2.2's fall flag needs an impact *then* stillness. Asserting this keeps the
    // control above from being mistaken for fall detection.
    expect(collapsed.byCategory.fall.flagged).toBe(false);
    expect(collapsed.criticalRules).not.toContain('fall.impactThenStillness');
  });

  it('satisfies fatigue’s stillness half without firing it, because the pulse is settled', () => {
    // Half of a conjunction, asserted directly: fifteen minutes of stillness are present
    // here, so the green fatigue card on the demo screen is held green by the heart rate
    // alone. Without this the card could be green because the rule is dead.
    expect(collapsed.byCategory.fatigue.metric).toMatch(/still \d+ min$/);
    expect(collapsed.byCategory.fatigue.rule).toBeNull();
    expect(collapsed.byCategory.fatigue.level).toBe('green');
  });
});

describe('the advisory cards on the demo screen are reachable negatives', () => {
  /** The shipped window, motion removed, with `hr` transformed by `raise`. */
  function variant(raise: (hr: number, timestamp: number) => number): SensorReading[] {
    return buildMockReadings(NOW).map((reading) => ({
      ...reading,
      motionSummary: MOCK_WINDOW.still,
      hr: raise(reading.hr as number, reading.timestamp),
    }));
  }

  /**
   * Someone who stopped moving in extreme heat and whose pulse then climbed 20 bpm — the
   * elevation confined to the newest part of the window, which is what makes it a *drift*
   * away from the window's own baseline rather than a level.
   */
  const drifting = assessRisk({
    readings: variant((hr, timestamp) => (timestamp > NOW - 9 * 60_000 ? hr + 20 : hr)),
    environment,
    now: NOW,
  });

  /**
   * The same 20 bpm, raised across the *whole* window instead. Nothing drifts — the baseline
   * moves with it — but the pulse is now elevated through fifteen unbroken minutes of
   * stillness, which is the fatigue shape.
   */
  const sustained = assessRisk({
    readings: variant((hr) => hr + 20),
    environment,
    now: NOW,
  });

  it('fires dehydration on heat plus drift, and only as an advisory', () => {
    expect(drifting.byCategory.dehydration.firedRules).toContain(
      'dehydration.cardiovascularDrift',
    );
    expect(drifting.byCategory.dehydration.level).not.toBe('green');

    // The containment, asserted where it would actually be felt: this fixture *is* an SOS
    // candidate — `heat.stillness.critical` fires on the same window — so if dehydration
    // could contribute a critical rule it would be adding a second reason to text every
    // emergency contact. It cannot.
    expect(drifting.sosCandidate).toBe(true);
    expect(drifting.byCategory.dehydration.flagged).toBe(false);
    expect(drifting.byCategory.dehydration.criticalRules).toEqual([]);
    expect(drifting.flaggedRules).not.toContain('dehydration.cardiovascularDrift');
    expect(drifting.criticalRules).not.toContain('dehydration.cardiovascularDrift');
  });

  it('fires fatigue on stillness plus an elevated pulse, capped at amber', () => {
    expect(sustained.byCategory.fatigue.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
    expect(sustained.byCategory.fatigue.level).toBe('amber');
    expect(sustained.byCategory.fatigue.flagged).toBe(false);
    expect(sustained.byCategory.fatigue.criticalRules).toEqual([]);
  });

  it('separates the two shapes rather than reporting both on either', () => {
    // The pair is the point. A single elevated-heart-rate fixture that lit both cards would
    // mean the two rules are measuring the same thing under different names, and either one
    // could then be deleted without a test noticing.
    expect(drifting.byCategory.fatigue.rule).toBeNull();
    expect(sustained.byCategory.dehydration.rule).toBeNull();
  });
});

/**
 * The vitals row's rolling averages over the same window (PRD §7.2.1 extension).
 *
 * Two questions here that `risk/__tests__/baseline.test.ts` cannot answer, because it builds its
 * own synthetic windows. The first is what the *shipped* window actually says, which is what a
 * reviewer sees on the demo screen. The second is what the row says next to the advisory cards,
 * which read 15 and 18 minutes of the same buffer against baselines split a different way — and
 * therefore can, correctly, disagree with it.
 */
describe('the personal baselines the vitals row shows for this window', () => {
  /** The shipped window, motion removed, with `hr` transformed by `raise`. Mirrors the helper in
   *  the block above; kept local so neither block's fixtures can drift into the other's. */
  function variant(raise: (hr: number, timestamp: number) => number): SensorReading[] {
    return buildMockReadings(NOW).map((reading) => ({
      ...reading,
      motionSummary: MOCK_WINDOW.still,
      hr: raise(reading.hr as number, reading.timestamp),
    }));
  }

  function baselinesOf(input: readonly SensorReading[]) {
    return computeVitalBaselines({
      readings: input,
      assessment: assessRisk({ readings: input, environment, now: NOW }),
    });
  }

  const baselines = computeVitalBaselines({ readings, assessment });
  const [hr, spo2, skinTemp] = baselines.vitals;

  it('describes the same window the cards were computed over', () => {
    expect(baselines.windowMs).toBe(assessment.windowMs);
    expect(baselines.evaluatedAt).toBe(assessment.evaluatedAt);
    expect(baselines.windowLabel).toBe('10-minute');
  });

  it('averages ten of the twenty readings, because the window is half the buffer', () => {
    // The buffer deliberately reaches back further than any single lookback. The row must read
    // only its own ten minutes of it, or "your 10-minute average" is not one.
    expect(readings).toHaveLength(20);
    for (const vital of baselines.vitals) {
      expect(vital.sampleCount).toBe(10);
      expect(vital.baselineCount).toBe(9);
      expect(vital.dataQuality).toBe('ok');
    }
  });

  it('is a quiet window on every vital — which is why the card has its own test file', () => {
    // Every difference here is a fraction of its deadband, so nothing rendered from the shipped
    // fixture can show that a deviation reaches the screen at all. Pinned rather than described,
    // because the moment one of these numbers moves the demo screen changes and the component
    // tests in `components/__tests__/vitals-card.test.tsx` are the only cover for the other
    // states.
    expect(hr.current).toBe(78);
    expect(hr.baseline).toBeCloseTo(77.778, 3);
    expect(hr.percentDelta).toBeCloseTo(0.286, 3);
    expect(spo2.delta).toBeCloseTo(-0.222, 3);
    // Exactly zero: the nine history temperatures average to 36.8 to the last bit.
    expect(skinTemp.delta).toBeCloseTo(0, 6);

    for (const vital of baselines.vitals) {
      expect(vital.meaningful).toBe(false);
      expect(vital.short).toBe('In line');
      expect(Math.abs(vital.noiseMultiple)).toBeLessThan(1);
    }
    expect(baselines.headline).toBe('In line with your 10-minute average.');
  });

  it('agrees with the dehydration card’s baseline where they overlap', () => {
    // Two baselines for the same vital appear on one screen, four cards apart. On this window
    // they land on the same rounded number, and that is worth pinning: a reviewer who saw 78 in
    // one place and 74 in the other would reasonably read it as a bug.
    expect(Math.round(hr.baseline as number)).toBe(78);
    expect(assessment.byCategory.dehydration.metric).toBe('HR +0 bpm vs baseline 78');
  });

  it('stays in line while the dehydration card reports a 22 bpm rise — both correct', () => {
    // **This divergence is the design, not a defect.** The rise fills the newest nine of the ten
    // minutes the row reads, so it is almost entirely inside the row's own average and barely
    // visible against it: 2.4 bpm. Dehydration reads fifteen minutes and splits its baseline by
    // *count* — the oldest 40 % of samples — so the same rise sits almost entirely outside its
    // baseline and reads as 22.
    //
    // Widening the row's window to 18 minutes would collapse the two, and was rejected: the
    // brief specifies "the current sensor window", which in this engine is `window.ms`. What
    // keeps the pair honest instead is that every string names its horizon, so the screen reads
    // "in line with your 10-minute average" beside "HR +22 bpm vs baseline 78" rather than two
    // bare, contradictory claims.
    const drifting = variant((value, timestamp) =>
      timestamp > NOW - 9 * 60_000 ? value + 20 : value,
    );

    expect(baselinesOf(drifting).vitals[0].short).toBe('In line');
    expect(baselinesOf(drifting).vitals[0].delta).toBeCloseTo(2.444, 3);
    expect(assessRisk({ readings: drifting, environment, now: NOW }).byCategory.dehydration.metric)
      .toBe('HR +22 bpm vs baseline 78');
  });

  it('stays in line when the whole window is raised, because a baseline is relative', () => {
    // +20 bpm everywhere. The fatigue card fires on it; the row does not, and should not — the
    // user's recent average *is* 98, and reporting a deviation from it would be false. This is
    // the limit of what a window-relative statistic can see, and it is why the row is a
    // description rather than a seventh rule.
    const sustained = variant((value) => value + 20);
    const result = baselinesOf(sustained);

    expect(result.vitals[0].current).toBe(98);
    expect(result.vitals[0].baseline).toBeCloseTo(97.778, 3);
    expect(result.vitals[0].short).toBe('In line');
    expect(assessRisk({ readings: sustained, environment, now: NOW }).byCategory.fatigue.level).toBe(
      'amber',
    );
  });

  it('speaks when the rise is recent enough to stand out from its own average', () => {
    // The reachable positive for this fixture family, and the answer to "can this row ever say
    // anything on the demo window". Confining the same 20 bpm to the newest four minutes leaves
    // six minutes of quiet baseline underneath it.
    const recent = variant((value, timestamp) => (timestamp > NOW - 4 * 60_000 ? value + 20 : value));
    const vital = baselinesOf(recent).vitals[0];

    expect(vital.baseline).toBeCloseTo(84.444, 3);
    expect(vital.percentDelta).toBeCloseTo(16.053, 3);
    expect(vital.meaningful).toBe(true);
    expect(vital.short).toBe('+16%');
    expect(vital.summary).toBe('Heart rate is 16% above your 10-minute average.');
  });
});

describe('spliceSimulatedFall (live mode)', () => {
  const NOW = 1_766_000_000_000;
  const MINUTE = 60_000;

  /** A quiet live buffer: HR every 30 s and a still motion reading at each past poll. */
  function liveReadings(): SensorReading[] {
    const out: SensorReading[] = [];
    for (let offset = -20 * MINUTE; offset <= 0; offset += 30_000) {
      out.push({ source: 'health_connect', timestamp: NOW + offset, hr: 74 });
      if (offset % MINUTE === 0) {
        out.push({
          source: 'health_connect',
          timestamp: NOW + offset,
          motionSummary: MOCK_WINDOW.still,
        });
      }
    }
    return out;
  }

  it('leaves a quiet live buffer green with no SOS candidate', () => {
    const assessment = assessRisk({ readings: liveReadings(), now: NOW });
    expect(assessment.byCategory.fall.level).toBe('green');
    expect(assessment.sosCandidate).toBe(false);
  });

  it('turns the same live buffer into a confirmed, ongoing fall the engine escalates', () => {
    const readings = spliceSimulatedFall(liveReadings(), NOW);
    const assessment = assessRisk({ readings, now: NOW });

    expect(assessment.byCategory.fall.rule).toBe('fall.impactThenStillness');
    expect(assessment.byCategory.fall.criticalRules).toContain('fall.impactThenStillness');
    expect(assessment.sosCandidate).toBe(true);
  });

  it('keeps every live vital and only replaces motion inside the spliced span', () => {
    const live = liveReadings();
    const spliced = spliceSimulatedFall(live, NOW);
    const hrCount = (rs: readonly SensorReading[]) => rs.filter((r) => r.hr !== undefined).length;
    expect(hrCount(spliced)).toBe(hrCount(live));
    // Newest reading is the spliced still sample, so the trailing-still run is measurable.
    const newest = spliced[spliced.length - 1];
    expect(newest.timestamp).toBe(NOW);
    expect(newest.motionSummary).toEqual(MOCK_WINDOW.still);
  });

  it('is a no-op shape-wise on an empty buffer: three motion readings, nothing else', () => {
    const spliced = spliceSimulatedFall([], NOW);
    expect(spliced.map((r) => r.timestamp - NOW)).toEqual([-2 * MINUTE, -MINUTE, 0]);
    expect(spliced[0].motionSummary).toEqual(MOCK_WINDOW.fallImpact);
  });
});

// ---------------------------------------------------------------------------
// Demo mode's heat-wave environment (workstream I1)
// ---------------------------------------------------------------------------

/**
 * The heat-wave counterpart of `FALL_MOTION`, and the same discipline applies: the demo shapes
 * the engine's *input* — two weather numbers — and the heat rule has to reach Extreme Danger on
 * its own from them. Nothing here may assert a band that the demo constant itself declares.
 *
 * Which is why these tests derive the expectation from `heat-index.ts`'s published NOAA floor
 * rather than restating "125". A demo temperature that quietly slipped under the floor would
 * otherwise still light a red card (Danger is red too) and nobody would notice that the band
 * being demonstrated was not the band on the label.
 */
describe('DEMO_HEAT_WAVE_ENVIRONMENT (demo mode)', () => {
  const NOW = 1_766_000_000_000;

  it('is the two documented weather numbers and nothing else', () => {
    // Deliberately no `heatIndexC`: `EnvironmentSnapshot.heatIndexC` is a trusted-upstream
    // *override*, and supplying one would let the demo hand the engine its own answer. The
    // whole point is that `rules/heat.ts` computes the index from these two numbers.
    expect(DEMO_HEAT_WAVE_ENVIRONMENT).toEqual({ tempC: 44, humidity: 55 });
  });

  it('reaches NOAA’s Extreme Danger floor from the temperature and humidity alone', () => {
    const { tempC, humidity } = DEMO_HEAT_WAVE_ENVIRONMENT;
    const heatIndexF = computeHeatIndexF(celsiusToFahrenheit(tempC), humidity);

    expect(heatIndexF).not.toBeNull();
    expect(heatIndexF as number).toBeGreaterThanOrEqual(HEAT_INDEX_BAND_MIN_F.extremeDanger);
  });

  it('stamps the observation at `now`, so the engine never scores it stale', () => {
    const snapshot = buildDemoHeatWaveSnapshot(null, NOW);

    expect(snapshot.observedAt).toBe(NOW);
    expect(NOW - (snapshot.observedAt as number)).toBeLessThan(T.env.maxStaleMs);
  });

  it('carries the real observation’s AQI through, so only the heat is simulated', () => {
    const real = buildEnvironmentSnapshot(liveEnvironment({ aqi: 168 }));
    const snapshot = buildDemoHeatWaveSnapshot(real, NOW);

    expect(snapshot.aqi).toBe(168);
    expect(snapshot.tempC).toBe(44);
    expect(snapshot.humidity).toBe(55);
  });

  it('omits the AQI entirely when there is no real observation to carry one from', () => {
    // Not zero, and not a made-up number. `EnvironmentSnapshot.aqi` is optional precisely so
    // the respiratory rule can say "unknown" instead of asserting clean air on nothing.
    expect(buildDemoHeatWaveSnapshot(null, NOW)).not.toHaveProperty('aqi');
    expect(
      buildDemoHeatWaveSnapshot(buildEnvironmentSnapshot(liveEnvironment({ aqi: null })), NOW),
    ).not.toHaveProperty('aqi');
  });

  it('makes the real heat rule fire `heat.index.extremeDanger` on the demo window', () => {
    const assessment = assessRisk({
      readings: buildMockReadings(NOW),
      environment: buildDemoHeatWaveSnapshot(null, NOW),
      now: NOW,
    });
    const heat = assessment.byCategory.heat;

    expect(heat.firedRules).toContain('heat.index.extremeDanger');
    expect(heat.level).toBe('red');
    // Composed inside `rules/heat.ts` — the ladder's 90-rung headline, selected by a score the
    // rule derived from the index it computed itself. This string exists nowhere in the demo
    // constant or in this file's inputs.
    expect(heat.guidance).toBe(
      'Extreme heat danger — get indoors or into shade and cool down now.',
    );
  });

  it('does not escalate to suspected heat collapse on the moving demo window', () => {
    // The shipped window's tail is `ACTIVE`. Extreme heat alone is not an emergency — PRD
    // §7.2.5 needs ten trailing minutes of stillness too — so a demo heat wave must *not* open
    // the SOS countdown. If it did, the fall demo could no longer be told apart from it.
    const assessment = assessRisk({
      readings: buildMockReadings(NOW),
      environment: buildDemoHeatWaveSnapshot(null, NOW),
      now: NOW,
    });

    expect(assessment.byCategory.heat.criticalRules).toEqual([]);
    expect(assessment.criticalRules).toEqual([]);
    expect(assessment.sosCandidate).toBe(false);
  });

  it('reports the index as a floor, because 44 °C is past the regression’s domain', () => {
    // 44 °C is 111.2 °F, over `HEAT_INDEX_MAX_VALID_TEMP_F` (110). The engine's own presentation
    // guard therefore marks the category `partial` and prints "over N°C" rather than a figure a
    // person could read as an apparent temperature. That is the honest rendering of a real
    // Indian heat-wave temperature, and it is pinned here so it cannot regress into a confident
    // number the NWS chart does not cover.
    const heat = assessRisk({
      readings: buildMockReadings(NOW),
      environment: buildDemoHeatWaveSnapshot(null, NOW),
      now: NOW,
    }).byCategory.heat;

    expect(heat.dataQuality).toBe('partial');
    expect(heat.metric).toMatch(/^Heat index over \d+°C$/);
  });
});
