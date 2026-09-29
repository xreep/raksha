# Raksha

Offline AI health guardian for heat waves, floods and smog. Built for Smart India Hackathon 2026, PS 26181 (Qualcomm).

## What it does

Raksha reads vitals from a wearable through Android Health Connect, folds in the phone's own
accelerometer, and scores health risk **on the device** — no account, no server, no vitals leaving
the phone. It combines those readings with local weather and air quality to answer a question a
fitness app cannot: *is this heart rate, in this heat, a problem for this person right now?*

- **On-device risk scoring.** Six rule categories — heat stress (NOAA heat index), respiratory,
  cardiovascular, falls, dehydration and fatigue — each producing a level, a plain-language
  recommendation and a 0–100 score. Runs with no connectivity.
- **Environmental context.** Live temperature, humidity and air quality for a coarse location;
  cached so the last known reading still informs the score offline.
- **Disaster-relevant alerts.** Heat-index bands, an air-quality advisory that raises respiratory
  risk when the AQI is unhealthy, and static flood/cyclone preparedness guidance.
- **Emergency SOS.** A critical reading starts a 30-second cancel window, then sends the alert
  with vitals and a location link — automatically over any data connection via a relay the team
  owns, and as a pre-filled SMS needing one tap when there is no data.
- **Local history.** Readings are stored on the phone for seven days and shown as 24-hour and
  7-day trends. An erase control deletes them.

## Current status

Verified on one Android 15 device with an EAS development build unless noted. "Device validated"
means it ran on that phone, not that it has been tested with real users over time.

**Done — device validated**

- Health Connect ingestion: permissions, heart rate and SpO₂ read into the risk engine.
- Rule engine on live data: SpO₂ below the threshold raises the respiratory card; two critical
  samples escalate to the SOS countdown.
- Air-quality advisory firing on real local AQI.
- Local notifications on a risk-level change, including the foreground-handler fix that made them
  appear at all.
- SOS fallback: countdown expiry opens the SMS composer, pre-filled and addressed.
- Emergency relay deployed on Cloudflare Workers; a Telegram alert delivered to a real phone in
  about a second.

**Done — code complete, tested in CI, not yet exercised on the phone**

- Persistent reading store (SQLite) and the trends screen that reads from it.
- App-side relay dispatch and the in-app Telegram linking flow for an emergency contact.
- User profile capture (age band, chronic condition, outdoor worker). It deliberately does not
  change any threshold yet; that needs a methodology review first.

**Known limitations**

- Sensing runs only while the app is open. A fall with the phone in a pocket and the screen off is
  not detected yet. Background sensing is the next milestone.
- Free SMS gateways refuse Indian numbers, and no consumer app on Android or iOS may send an SMS
  silently. Automatic delivery therefore needs a data connection (Telegram today); without data the
  composer path costs the user one tap.
- The local database is not encrypted yet.
- No accuracy, false-positive or battery figure is claimed anywhere, because none has been measured.

**Planned**

- Raksha Band wearable (XIAO ESP32-C3 with pulse, temperature and motion sensors) and a BLE adapter.
  The sensor-source picker lists it, but no firmware or BLE code exists in this repository.
- On-band fall detection.
- Encrypted local storage with the key in the Android Keystore.
- Caregiver role with push alerts, seven-day personal baselines with an explainable anomaly score,
  Hindi interface, and background sensing via a foreground service.

## Tech stack

Expo SDK 57, React Native 0.86, React 19, TypeScript 6, Expo Router. Health Connect via
`react-native-health-connect`; sensors via `expo-sensors`; storage via `expo-sqlite` and
AsyncStorage; alerts via `expo-notifications`; location via `expo-location`; SMS fallback via
`expo-sms`. The emergency relay under `relay/` is a Cloudflare Worker in TypeScript, tested with
Vitest. Application tests use Jest with `jest-expo` and React Native Testing Library: 63 suites,
1457 tests. CI runs type checking, linting, both test suites and `expo-doctor` on every push.

## Setup

Requires Node 22 and an Expo account for device builds.

```
npm install
```

Create `.env.local` (git-ignored):

```
EXPO_PUBLIC_OPENWEATHER_API_KEY=your_key
EXPO_PUBLIC_SOS_RELAY_URL=https://your-worker.workers.dev/sos
```

The relay URL must end in `/sos`. Leaving it unset is supported: SOS then uses the SMS composer.

## Run

Health Connect is a native module, so Expo Go cannot run this app. Build a development client once:

```
eas build --profile development --platform android
```

Install the resulting APK, then start the bundler:

```
npx expo start --dev-client
```

Add `--tunnel` if the phone and the development machine are not on the same network.

## Tests

```
npm test
npx tsc --noEmit
npx eslint src --max-warnings 0
cd relay && npm test
```

## Documentation

- `docs/PROJECT_STATUS.md` — what is built, tested and validated, with the blockers.
- `docs/ROADMAP.md` — milestones.
- `docs/features/` — one document per feature, including the emergency relay contract.
- `docs/decisions/` — architecture decision records.
- `docs/validation/device-validation-plan.md` — the on-device test protocol and its results.
