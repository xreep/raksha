# Demo mode (release-build simulation controls, I1)

## Feature
A persisted, off-by-default Settings switch that puts two simulation controls on the Dashboard —
"Simulate a fall" and "Simulate a heat wave" — in **release** builds, alongside a "Demo mode"
label that stays on screen the entire time the mode is on. Each control shapes one of the risk
engine's two inputs; neither touches its output, and neither reading is ever written to the
reading store.

## Objective
The whole claim this project makes is that a deterministic on-device rule engine reacts to real
inputs. That claim is only checkable if someone holding the phone can watch it react. Two of the
six categories cannot be demonstrated by waiting:

- **Fall** — the shipped sensor window describes a person moving about, so `rules/fall.ts` is
  permanently green and PRD §7.2.5's SOS countdown is unreachable on a running app.
- **Heat** — the heat card reads the *real* weather for the device's coarse location (PRD §7.2.3),
  which means the Extreme Danger band is reachable only on a genuinely extreme day in a genuinely
  extreme place. A demo in an air-conditioned room shows a green card and proves nothing.

A `__DEV__`-gated control cannot close either gap, because `__DEV__` is false in the bundle that
actually gets shared. This milestone makes the affordance a user-controlled setting instead.

## Problem
Putting simulation controls in a shipping health app is a real hazard, not a formality. The
failure it invites is that someone reads a simulated Extreme Danger heat card, or a simulated
fall alert, as a statement about a person. Three things have to be true for the feature to be
worth having at all, and each of them fails *silently* if it stops being true:

1. **Off unless asked for.** A user who never opens Settings must never be able to reach a
   simulated reading.
2. **Labelled the whole time.** The dangerous state is not "a simulated reading is showing" — it
   is "a simulated reading is one tap away and nothing on screen says so."
3. **Input-shaping, never output-faking.** A control that forced the fall card red, or that
   pushed a rule id into `criticalRules` directly, would demonstrate the *card* and prove nothing
   about the detector. Worse, it would be a lie in the one direction that matters: the rule would
   look reachable in a demo while being unreachable on hardware.

## The honesty guarantees
These three are the feature. Each is pinned by a test that fails if the guarantee is removed.

### 1. A visible label, tied to the mode and not to the controls
While `settings.demoMode` is on, the Dashboard's subtitle slot carries a red-outlined **Demo
mode** pill — before anything is armed, while something is armed, and after it is cleared.

It sits in the subtitle because that is already where the Dashboard states the *provenance* of
everything below it ("Updated 30s ago · Simulated data"), so "some of this can be simulated"
belongs in the same line of sight rather than in a second place a reader has to know to look. It
is a pill rather than more text on that line because the freshness line is grey secondary prose
that a viewer skims past, and a label that can be skimmed past is not a label.

While a control *is* armed, its own hint copy resolves the general warning into a specific one:
which card is looking at a simulated input, and what that input was.

### 2. Input-shaping, not output-faking
Neither control ever touches a `RiskAssessment`. Both change what `assessRisk` is *handed*:

- **Fall** reuses the existing `spliceSimulatedFall` / `buildMockReadings({ simulateFall })` path
  unchanged — no splice logic was duplicated for this milestone. `rules/fall.ts` finds the impact,
  measures the stillness after it, and escalates on its own terms.
- **Heat** hands `assessRisk` a `DEMO_HEAT_WAVE_ENVIRONMENT` snapshot of 44 °C and 55 % RH, and
  `rules/heat.ts` runs the NOAA regression over those two numbers and bands the result itself.

The heat constant deliberately carries **no `heatIndexC`**. That field is a trusted-upstream
override: supply one and the heat rule stops computing and starts believing, which would be the
heat equivalent of forcing the card red. `mock-sensor-window.test.ts` asserts the computed index
clears `HEAT_INDEX_BAND_MIN_F.extremeDanger` rather than restating "125" or asserting a colour —
Danger is red too, so a colour assertion would pass against the wrong band.

### 3. Never persisted
`useSensors` is the only writer to the reading store, and it writes only what it polled. The demo
shaping happens strictly downstream of it, inside `useRiskAssessment`'s memo, so a simulated
reading has no path to `store.append`. That holds structurally, but "holds structurally" is
exactly the kind of claim that stops being true the first time someone moves the splice upstream —
so `demo-mode.test.tsx` asserts it at the boundary it would have to cross, with both controls
armed and a live Health Connect feed genuinely writing real readings alongside.

## Architecture
```
Settings ─ "Demo mode" switch ─▶ PersistedSettings.demoMode   (src/settings/store.ts)
                                        │  AsyncStorage, validate-on-read, fails closed
                                        ▼
                          useSettings() ─ shared SettingsProvider
                                        │
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
        Dashboard pill + two controls          useRiskAssessment({ simulateFall,
        (src/app/index.tsx)                                      simulateHeatWave })
                                                             │
                     readings ◀── spliceSimulatedFall / buildMockReadings
                     environment ◀── buildDemoHeatWaveSnapshot(real, now)
                                                             ▼
                                                        assessRisk(...)
                                                     the real Tier-1 engine
```
Nothing in `src/risk/`, `src/store/`, `src/sos/`, or the relay was touched. The engine does not
know demo mode exists, which is the property that makes the demo evidence rather than theatre.

## Implementation
- **`src/settings/store.ts`** — `PersistedSettings.demoMode: boolean`, default `false`.
  `parseSettings` reads it as `record.demoMode === true`. That **fails closed**, unlike
  `parseAlerts` which defaults its field on: a missing field is an old blob and a `'true'` or a
  `1` is a blob we do not understand, and neither is a user asking for simulated readings. Only a
  literal boolean `true` turns it on. `SETTINGS_KEY` is **not** bumped — the field is additive and
  old blobs load with everything else intact.
- **`src/settings/provider.tsx`** — `setDemoMode(enabled)`, a one-field patch like
  `setAlertsEnabled`.
- **`src/app/settings.tsx`** — a `SettingRow` switch in its own section placed after "About you".
  Its own section rather than a row inside "About you" or "Data sharing": this is the only
  setting that changes what the Dashboard *claims to have measured*, and burying it among
  preferences that describe the user, or among ones that govern what leaves the phone, would
  understate it.
- **`src/constants/mock-sensor-window.ts`** — `DEMO_HEAT_WAVE_ENVIRONMENT` (`{ tempC: 44,
  humidity: 55 }`) and `buildDemoHeatWaveSnapshot(real, now)`, placed beside `FALL_IMPACT` and
  `FALL_MOTION` so all the demo constants live together. The snapshot carries the **real**
  observation's AQI through when the feed has produced one, so the respiratory card keeps
  describing the air the user is actually breathing while the heat card describes simulated
  weather; the AQI is **omitted** rather than zeroed when there is no observation yet, for the
  reason `buildEnvironmentSnapshot` already gives about `null` — an absent AQI makes the
  respiratory rule decline to judge, a `0` would have it assert clean air on nothing.
  `observedAt` is `now`, not the real observation's timestamp: a simulated reading is made at the
  instant it is injected, and back-dating it to an observation that may be 50 minutes old would
  have `env.maxStaleMs` mark the demo stale partway through showing it.
- **`src/hooks/use-risk-assessment.ts`** — `simulateHeatWave?: boolean`, written as the
  environment-side twin of the existing `simulateFall` line: one branch, at the input, choosing
  which snapshot the engine is handed.
- **`src/app/index.tsx`** — the `__DEV__` block is replaced by a `settings.demoMode` block holding
  two `DemoControl`s with the same dashed treatment the dev tool always had. Both `fallArmed` and
  `heatArmed` are gated on `demoMode` **as well as** on their local `useState`, so turning the
  setting off in Settings genuinely returns the Dashboard to real data rather than hiding the
  buttons while the engine goes on scoring a shaped input. The two controls toggle independently
  and both may be armed at once.

### Why 44 °C at 55 % RH
Both are ordinary readings for an Indian pre-monsoon heat wave, which is the point: a demo that
needed physically absurd weather to reach Extreme Danger would be showing an unreachable rule.
They yield a NOAA index of ~166 °F, comfortably over the 125 °F Extreme Danger floor.

At 111.2 °F the dry-bulb temperature also sits just past `HEAT_INDEX_MAX_VALID_TEMP_F` (110), so
the engine's own presentation guard marks the heat category `dataQuality: 'partial'` and prints
the index as a floor ("Heat index over 75°C") rather than a number the published NWS chart covers.
That is the correct and honest rendering of a real heat-wave temperature — the guard doing its job
— and it is pinned by test so nobody later "fixes" it into a confident figure.

### One behaviour change beyond the brief
`useAlerts` is now called with `live: live && !demoArmed`. This extends the existing rule rather
than adding a new one: `live` already means "these readings are trustworthy real data", and an
armed demo control makes that false again even on a Health Connect buffer. Notifying off shaped
input is precisely the failure `live` exists to prevent, and a demo notification would outlive the
demo — it stays in the notification shade long after the label has left the screen.

## Files
- `src/settings/store.ts`, `src/settings/__tests__/store.test.ts`
- `src/settings/provider.tsx`
- `src/app/settings.tsx`, `src/__tests__/settings-screen.test.tsx`
- `src/app/index.tsx`
- `src/constants/mock-sensor-window.ts`, `src/constants/__tests__/mock-sensor-window.test.ts`
- `src/hooks/use-risk-assessment.ts`, `src/hooks/__tests__/use-risk-assessment.test.ts`
- `src/__tests__/demo-mode.test.tsx` (new)
- `src/__tests__/simulate-fall.test.tsx` (re-gated on `demoMode`; every behavioural assertion
  unchanged)

## Data Flow
1. The user turns Demo mode on in Settings. `setDemoMode` patches `PersistedSettings` and the
   provider persists the blob to AsyncStorage. Nothing leaves the device.
2. The Dashboard reads `settings.demoMode` from the shared provider and renders the pill and the
   two controls.
3. Arming a control sets local component state. `useRiskAssessment` then either splices the fall
   motion into the reading buffer or swaps the environment snapshot, and calls the real
   `assessRisk`.
4. The reading store is **not** in this path. `useSensors` appends only what it polled from Health
   Connect and the phone accelerometer, upstream of any demo shaping.
5. An SOS raised from a simulated fall behaves exactly as a real one does, including the 30-second
   cancel window — see Known Limitations.

## Tests
Unit / integration, Jest + RNTL. 64 suites / 1495 tests pass (baseline before this workstream: 63
/ 1457).

- **`src/settings/__tests__/store.test.ts`** — `demoMode` default `false`; an old blob with no
  such field loads with the rest of its contents intact; a stored `true` is honoured; a full
  round trip; and a table of ten non-`true` values (`'true'`, `1`, `{}`, `null`, …) all reading as
  off, which is the fail-closed rule.
- **`src/__tests__/settings-screen.test.tsx`** — the switch renders off by default, the
  description is asserted **verbatim** (a health app's honesty claims are part of the feature, and
  prose quietly softened in a later edit is the change no behavioural test would catch), toggling
  on and back off both persist, and the state survives a remount.
- **`src/constants/__tests__/mock-sensor-window.test.ts`** — `DEMO_HEAT_WAVE_ENVIRONMENT` is
  exactly the two documented numbers and carries no `heatIndexC`; the computed index clears
  `HEAT_INDEX_BAND_MIN_F.extremeDanger` (derived from `heat-index.ts`'s published floor, not
  restated); `observedAt` is `now` and inside `env.maxStaleMs`; the real AQI is carried through
  and omitted when absent; the real engine fires `heat.index.extremeDanger` and writes the
  ladder's 90-rung headline; the moving demo window does **not** escalate to suspected heat
  collapse; and the index is reported as a floor with `dataQuality: 'partial'`.
- **`src/hooks/__tests__/use-risk-assessment.test.ts`** — with `simulateHeatWave` omitted or
  explicitly `false`, the assessment is byte-identical to the pre-existing output (captured
  before/after in the same test, against a baseline asserted to be a genuinely cool day, so
  "unchanged" is falsifiable); armed, the heat rule reaches Extreme Danger; the real AQI survives
  the swap; the readings are untouched; it composes with `simulateFall` without either swallowing
  the other; and it works before the environment feed has produced any observation.
- **`src/__tests__/demo-mode.test.tsx`** (new, 16 tests) — with `demoMode: false` neither control
  and no label render, including for a pre-feature blob; with `demoMode: true` both controls
  render and the label is present *before anything is armed* and stays up while armed; arming heat
  produces the engine's own Extreme Danger headline and "Heat index over N°C" metric, moves
  exactly one card, and does not open the SOS countdown; both armed drive both rules while the
  countdown still names only the fall; turning the setting off while the Dashboard stays mounted
  disarms the engine rather than only hiding the buttons (both screens are mounted under one
  `SettingsProvider`, because a remount would reset `useState` and pass whether or not the gate
  existed — verified by mutation: removing the `demoMode &&` gate fails this test); and the store
  assertions of point 3 above.
- **`src/__tests__/simulate-fall.test.tsx`** — re-gated on `demoMode: true`. Every assertion about
  what the trigger *does* is unchanged, deliberately: the release-build affordance had better
  drive exactly the same detector the dev-only one did.

## Device Validation
**NO.** Nothing here has run on a phone. This workstream adds no native dependency and changes no
native configuration, so it needs no new EAS build beyond whatever the branch is built with. What
a device run should confirm:
- The controls actually appear in a **release** APK with Demo mode on — the one thing Jest cannot
  check, since `__DEV__` is true under test and the point of the change is the bundle where it is
  false.
- The "Demo mode" pill is legible at real device widths in both light and dark themes, and wraps
  rather than truncating beside a long freshness line.
- Arming the heat control on a phone with a real weather fetch in flight swaps the card without
  the live observation racing back over it.
- An armed demo control does not produce a local notification (the `live && !demoArmed` gate),
  which under Jest is asserted only through `useAlerts`' inputs.

## Known Limitations
- **An SOS from a simulated fall is a real SOS.** Letting the 30-second countdown expire sends a
  genuine message to genuinely configured contacts. This is deliberate — a countdown that
  silently did not send would be demonstrating a send path that does not exist — but it means a
  demo must be cancelled, or run with no contacts configured. Nothing in the UI currently warns
  about this at the moment of arming; the cancel window itself names the contact it will reach.
- **The label is on the Dashboard only.** A viewer who navigates to Trends or Community while
  Demo mode is on sees no pill there. Those screens read the store and the demo cohort
  respectively, so neither can show a simulated *reading* — but the mode itself is not announced
  outside the Dashboard.
- **The heat demo replaces the whole weather observation, not just the temperature.** Location and
  the observation's real age are not shown on the Dashboard, so nothing on that screen
  contradicts the injection; the Environment screen still shows the real observation, which means
  the two screens disagree while the control is armed. That is arguably the honest arrangement
  (only the engine's input was shaped) but it is unlabelled on the Environment side.
- `dataQuality: 'partial'` on the demo heat card is correct but subtle — it reflects the NWS
  chart's domain limit, not a defect in the demo, and nothing on screen explains the distinction.

## Security
No new permissions. No new native modules. The setting is one boolean in the existing AsyncStorage
settings blob, which is app-private storage on Android. The controls are reachable only after a
deliberate Settings toggle, and the demo shaping cannot reach any outbound path that a real
reading could not already reach.

## Privacy
Nothing here transmits anything, and nothing here stores anything beyond the boolean itself — the
simulated readings exist only for the lifetime of one `useMemo` evaluation and are never handed to
`store.append` (asserted; see Tests). The one outbound path demo mode can reach is SOS, which is
unchanged and still governed by the `sharing.sos` consent gate — see
[`docs/security/privacy-architecture.md`](../security/privacy-architecture.md).

## Future Improvements
- Carry the Demo mode label onto every screen, or into the tab bar, so it cannot be left behind by
  navigation.
- A confirmation, or an explicit "demo SOS" mode that stops short of dispatch, so a demo cannot
  send a real message by being left alone for thirty seconds.
- Label the Environment screen while the heat control is armed, so the two screens stop
  disagreeing silently.
- A third control for the respiratory/AQI path, which has the same "only demonstrable on a bad
  day" problem as heat.

## Status
Built · Unit tested · Integration tested (screen-level, real engine) — **not device validated**.

---

## Proposed status-doc updates

The controller owns `docs/PROJECT_STATUS.md`, `docs/BUILD_MATRIX.md`, `docs/JUDGE_QA.md`,
`docs/ROADMAP.md`, and `CHANGELOG.md`; the entries below are proposed for those files, not applied
here.

### CHANGELOG fragment

```
### Added
- Demo mode: a persisted, off-by-default Settings switch that puts "Simulate a fall" and
  "Simulate a heat wave" controls on the Dashboard in release builds, with a "Demo mode" label
  that stays on screen the whole time the mode is on. Both controls shape the risk engine's
  *input* — a spliced impact-then-stillness sequence, or a 44 °C / 55 % RH observation the NOAA
  rule bands to Extreme Danger itself — and neither simulated reading is ever written to the
  reading store. See `docs/features/demo-mode.md`.

### Changed
- The "Simulate a fall" control is no longer gated on `__DEV__`; it is gated on the new
  `demoMode` setting, so it exists in the shareable APK. Its behaviour is unchanged.
- Local alert notifications are suppressed while a demo control is armed, extending the existing
  "never notify on the simulated window" rule.
```

### BUILD_MATRIX row

Replaces the existing `Fall detection (engine + motion)` row (`🟡 | ✅ | ❌ | ❌ | Unit tested;
demoed only via the dev "Simulate a fall" splice`), and adds one new row:

| Feature | Implemented | Tested | Device Validated | Real-World Validated | Status |
| --- | --- | --- | --- | --- | --- |
| Fall detection (engine + motion) | ✅ | ✅ | ❌ | ❌ | Unit tested; demonstrable in release builds via Demo mode's "Simulate a fall" splice |
| Demo mode (simulation controls) | ✅ | ✅ | ❌ | ❌ | Integration tested — user-controlled, always labelled, never persisted; not device validated |

### ROADMAP fragment

`docs/ROADMAP.md` is organised by numbered milestones (M0–M12) and currently has no workstream-I
section, so the controller will need to decide where this lands — it is demo tooling rather than a
product milestone, and may belong in the SIH-readiness summary rather than as an `### M…` heading.

```
**I1 — Demo mode: implemented, awaiting device validation.** `settings.demoMode` replaces the
`__DEV__` gate on the Dashboard's simulation controls and adds a heat-wave control alongside the
fall one — see `docs/features/demo-mode.md`. The honesty gates are met by tests: the mode is off
by default and fails closed on read; the "Demo mode" label renders whenever the mode is on, not
only when a control is armed; the heat rule reaches `heat.index.extremeDanger` from two injected
weather numbers on its own; and `store.append` is never handed a simulated reading with both
controls armed against a live Health Connect feed (`demo-mode.test.tsx`).
```

### JUDGE_QA fragment

A new entry, and one line appended to the existing **"What is simulated?"** answer.

```
### "Is what I'm seeing real or simulated?"
**Honest answer today:** If the "Demo mode" pill is on the Dashboard under the title, this phone
is in a mode where readings can be simulated at a tap — and if a control below the cards is lit
red, one currently is, with its own line saying which card and what was injected. With no pill,
nothing on screen was simulated by a demo control. Demo mode is off by default, has to be turned
on in Settings, and shapes only what the engine is *given*: the fall control splices a real
impact-then-stillness motion sequence into the sensor window, the heat control hands the engine a
44 °C / 55 % RH observation. The rules then reach their verdicts on their own — nothing forces a
card red — and neither simulated reading is ever written to your history.
**Evidence:** `src/app/index.tsx`, `src/constants/mock-sensor-window.ts`,
`src/__tests__/demo-mode.test.tsx`; `docs/features/demo-mode.md`.

(Appended to "What is simulated?":) A user-controlled Demo mode can additionally inject a
simulated fall or heat wave into the engine's input; whenever it is on, a "Demo mode" label is on
the Dashboard, and nothing it injects is saved.
```
