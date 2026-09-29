/**
 * Demo mode (workstream I1) on the real Dashboard.
 *
 * ## What this file is actually defending
 * Demo mode is the one feature in this app whose *purpose* is to put something untrue on
 * screen. Everything else here is built to stop that happening, so the feature only earns its
 * place if three claims hold, and each of them fails silently if it stops holding:
 *
 * 1. **It is off unless asked for.** With `demoMode: false` there is no control and no label —
 *    a user who never opens Settings cannot arrive at a simulated reading.
 * 2. **It says so, the whole time.** While `demoMode` is on the "Demo mode" label is on screen
 *    whether or not a control is armed, because the dangerous state is not "a simulated reading
 *    is showing" but "a simulated reading is one tap away and nothing says so".
 * 3. **It shapes the input and fakes nothing.** The heat control injects two weather numbers and
 *    `rules/heat.ts` reaches Extreme Danger on its own; the fall control injects a motion
 *    sequence and `rules/fall.ts` finds it. Neither reading is ever written to the store.
 *
 * So the assertions below are about rule ids and strings composed *inside the engine* — never
 * about a colour, which would pass just as well against a card someone had hardcoded, and never
 * about a band label the demo constant states for itself. `simulate-fall.test.tsx` already
 * proves the fall path end to end and is not duplicated here; what is new is the gating, the
 * label, the heat path, and the store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AlertsProvider } from '@/alerts/provider';
import HomeScreen from '@/app/index';
import SettingsScreen from '@/app/settings';
import { fetchLiveEnvironment, readCachedEnvironment } from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { EnvironmentProvider } from '@/environment/provider';
import type { SensorReading } from '@/risk';
import { checkHealthConnect, grantedVitalsPermissions, readVitals } from '@/sensors/health-connect';
import { isMotionAvailable, startMotionFold, type MotionFold } from '@/sensors/motion';
import { SensorProvider } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';
import { SETTINGS_KEY } from '@/settings/store';
import { MemoryReadingStore } from '@/store/memory';
import { ReadingStoreProvider } from '@/store/provider';

// Only the process boundaries are stubbed: the network, the Health Connect SDK, and the
// accelerometer. The engine, the hooks, the providers, and the screen are all shipping code.
jest.mock('@/environment', () => ({
  ...jest.requireActual('@/environment'),
  fetchLiveEnvironment: jest.fn(),
  readCachedEnvironment: jest.fn(),
}));

jest.mock('@/sensors/health-connect', () => ({
  ...jest.requireActual('@/sensors/health-connect'),
  checkHealthConnect: jest.fn(() => Promise.resolve('unavailable')),
  grantedVitalsPermissions: jest.fn(() => Promise.resolve([])),
  readVitals: jest.fn(() => Promise.resolve([])),
}));

jest.mock('@/sensors/motion', () => ({
  ...jest.requireActual('@/sensors/motion'),
  isMotionAvailable: jest.fn(() => Promise.resolve(false)),
  startMotionFold: jest.fn(),
}));

const mockedFetch = fetchLiveEnvironment as jest.MockedFunction<typeof fetchLiveEnvironment>;
const mockedRead = readCachedEnvironment as jest.MockedFunction<typeof readCachedEnvironment>;

/** Frozen instant, matching every other suite's anchor, so derived strings are exact. */
const NOW = 1_766_000_000_000;

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const FALL_CONTROL = 'Simulate a fall';
const HEAT_CONTROL = 'Simulate a heat wave';
const DEMO_LABEL = 'Demo mode';

let readingStore: MemoryReadingStore;
let appended: SensorReading[];

/**
 * A known store whose every `append` is recorded.
 *
 * Spied rather than inspected after the fact on purpose: the question is not "what survived in
 * the store" — a simulated reading could be written and then pruned — but "was a simulated
 * reading ever handed to it at all".
 */
function renderHome() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <EnvironmentProvider>
        <SettingsProvider>
          <ReadingStoreProvider store={readingStore}>
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
 * The Dashboard and the Settings screen under one `SettingsProvider`, which is how Expo Router
 * really holds them — both stay mounted, so a toggle thrown in Settings reaches a Dashboard
 * that has not been remounted and has not lost its local arm state.
 */
function renderBothScreens() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <EnvironmentProvider>
        <SettingsProvider>
          <ReadingStoreProvider store={readingStore}>
            <SensorProvider>
              <AlertsProvider>
                <HomeScreen />
                <SettingsScreen />
              </AlertsProvider>
            </SensorProvider>
          </ReadingStoreProvider>
        </SettingsProvider>
      </EnvironmentProvider>
    </SafeAreaProvider>,
  );
}

/** Seed the settings blob a user who made these choices would have left behind. */
async function seedSettings(settings: Record<string, unknown>) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockedFetch.mockReset();
  mockedRead.mockReset();
  mockedRead.mockResolvedValue(null);
  // A mild, clean day — 18 °C, AQI 32. Every card is green before anything is armed, so any
  // red on screen afterwards can only have come from what the demo injected.
  mockedFetch.mockResolvedValue(liveEnvironment({ tempC: 18, humidity: 55, aqi: 32 }));

  readingStore = new MemoryReadingStore();
  appended = [];
  jest.spyOn(readingStore, 'append').mockImplementation(async (readings) => {
    appended.push(...readings);
  });

  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Off unless asked for
// ---------------------------------------------------------------------------

describe('with demo mode off', () => {
  beforeEach(async () => {
    await seedSettings({ demoMode: false });
  });

  it('renders neither control and no label', async () => {
    const screen = await renderHome();

    // Waited for through something the screen definitely paints, so "absent" is a real absence
    // rather than a screen that had not rendered yet.
    await waitFor(() => expect(screen.getByText('Risk overview')).toBeTruthy());

    expect(screen.queryByText(FALL_CONTROL)).toBeNull();
    expect(screen.queryByText(HEAT_CONTROL)).toBeNull();
    expect(screen.queryByText(DEMO_LABEL)).toBeNull();
  });

  it('leaves the subtitle as the plain freshness line it has always been', async () => {
    const screen = await renderHome();

    await waitFor(() =>
      expect(screen.getByText('Updated 30s ago · Simulated data')).toBeTruthy(),
    );
  });

  it('is also the behaviour of a blob written before demo mode existed', async () => {
    await seedSettings({ userName: 'Asha' });

    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText('Risk overview')).toBeTruthy());

    expect(screen.queryByText(FALL_CONTROL)).toBeNull();
    expect(screen.queryByText(DEMO_LABEL)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. On, labelled, and both controls present
// ---------------------------------------------------------------------------

describe('with demo mode on', () => {
  beforeEach(async () => {
    await seedSettings({ demoMode: true });
  });

  it('renders both controls', async () => {
    const screen = await renderHome();

    await waitFor(() => expect(screen.getByText(FALL_CONTROL)).toBeTruthy());
    expect(screen.getByText(HEAT_CONTROL)).toBeTruthy();
  });

  it('shows the Demo mode label before anything is armed', async () => {
    // The claim in the Settings copy — "A 'Demo mode' label stays on screen while it is on" —
    // is about the mode, not about an armed control. This is the test that makes it true.
    const screen = await renderHome();

    await waitFor(() => expect(screen.getAllByText(DEMO_LABEL).length).toBeGreaterThan(0));
    // Nothing is simulated yet: every card is the engine's own verdict on a mild day.
    expect(screen.getAllByText('Normal')).toHaveLength(6);
  });

  it('keeps the label up while a control is armed', async () => {
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));

    await waitFor(() => expect(screen.getByText('Clear simulated heat wave')).toBeTruthy());
    expect(screen.getAllByText(DEMO_LABEL).length).toBeGreaterThan(0);
  });

  it('says which input is simulated while a control is armed', async () => {
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));

    await waitFor(() =>
      expect(
        screen.getByText(
          'A simulated 44°C at 55% humidity is standing in for your local weather. The Heat Stress card above is the risk engine’s own response to it — the air quality shown is still the real reading.',
        ),
      ).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The heat control reaches the Extreme Danger band through the real rule
// ---------------------------------------------------------------------------

describe('the simulated heat wave', () => {
  beforeEach(async () => {
    await seedSettings({ demoMode: true });
  });

  it('is inert until pressed — on an 18 °C day the heat card is the engine’s green', async () => {
    const screen = await renderHome();

    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());
    expect(screen.getByText('Heat conditions are comfortable.')).toBeTruthy();
  });

  it('turns the heat card into the ladder’s Extreme Danger rung', async () => {
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));

    // Composed inside `rules/heat.ts`: `recommend()` selects `HEAT_RECOMMENDATIONS`' 90-rung
    // from a score the rule derived from an index it computed itself out of 44 °C / 55 % RH.
    // Neither this string nor the score appears in the demo constant — that is what makes this
    // a test of the rule rather than of the button.
    await waitFor(() =>
      expect(
        screen.getByText('Extreme heat danger — get indoors or into shade and cool down now.'),
      ).toBeTruthy(),
    );
    // The metric is likewise the rule's own formatting, printed as a floor because 44 °C is
    // past the NWS chart's validated domain.
    expect(screen.getByText(/^Heat index over \d+°C$/)).toBeTruthy();

    // Exactly one card changed. Nothing about the weather can move a vital.
    expect(screen.getAllByText('Alert')).toHaveLength(1);
    expect(screen.getAllByText('Normal')).toHaveLength(5);
  });

  it('does not open the SOS countdown, because extreme heat alone is not an emergency', async () => {
    // PRD §7.2.5's collapse escalation needs ten trailing minutes of stillness as well, and the
    // demo window describes a person moving about. A heat demo that opened the countdown would
    // be claiming something the rule did not conclude.
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await waitFor(() => expect(screen.getByText('Clear simulated heat wave')).toBeTruthy());

    expect(screen.queryByText('CRITICAL RISK DETECTED')).toBeNull();
  });

  it('clears back to the engine’s green verdict, so the demo can be re-run', async () => {
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(HEAT_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await waitFor(() => expect(screen.getByText('Clear simulated heat wave')).toBeTruthy());
    await fireEvent.press(screen.getByText('Clear simulated heat wave'));

    await waitFor(() => expect(screen.getByText('Heat conditions are comfortable.')).toBeTruthy());
    expect(screen.getByText(HEAT_CONTROL)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. The two controls are independent
// ---------------------------------------------------------------------------

describe('both controls armed at once', () => {
  beforeEach(async () => {
    await seedSettings({
      demoMode: true,
      contacts: [{ id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210' }],
      userName: 'Asha',
    });
  });

  it('drives the heat rule and the fall rule independently', async () => {
    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(FALL_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await fireEvent.press(screen.getByText(FALL_CONTROL));

    // Both rules' own output, side by side. `assessFall` formatted the impact it found and the
    // stillness it measured; `rules/heat.ts` wrote the headline off its own score.
    await waitFor(() => expect(screen.getByText('Impact 3.1g, still 60s')).toBeTruthy());
    expect(
      screen.getByText('Extreme heat danger — get indoors or into shade and cool down now.'),
    ).toBeTruthy();
    expect(screen.getByText('Clear simulated fall')).toBeTruthy();
    expect(screen.getByText('Clear simulated heat wave')).toBeTruthy();
  });

  it('still names only the fall in the SOS countdown', async () => {
    // A 60-second still run is nowhere near `stillness.heatCriticalMs` (10 min), so heat's own
    // critical rule does not fire alongside. Pinned because a countdown that named two
    // emergencies at once would be demonstrating neither.
    const screen = await renderHome();
    await waitFor(() =>
      expect(screen.getByText(/^Alerts your contact with your location/)).toBeTruthy(),
    );

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await fireEvent.press(screen.getByText(FALL_CONTROL));

    await waitFor(() => expect(screen.getByText('CRITICAL RISK DETECTED')).toBeTruthy());
    expect(screen.getByText('· Possible fall, no movement since')).toBeTruthy();
    expect(screen.queryByText(/heat collapse/i)).toBeNull();
  });

  it('turning the setting off disarms them rather than just hiding them', async () => {
    // The arm state is local to the Dashboard and outlives the setting, so the gate has to be
    // on the *engine call* too — otherwise leaving Demo mode would remove the label and the
    // buttons while the Dashboard went on scoring a spliced window. That is a simulated reading
    // with nothing left saying so: the exact state this feature exists to make impossible.
    //
    // Both screens are mounted under one `SettingsProvider`, which is how Expo Router really
    // holds them — so the toggle is thrown while the Dashboard stays mounted with its controls
    // still armed. A remount would reset `useState` and pass whether or not the gate existed.
    const screen = await renderBothScreens();
    await waitFor(() => expect(screen.getByText(FALL_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await fireEvent.press(screen.getByText(FALL_CONTROL));
    await waitFor(() => expect(screen.getByText('Impact 3.1g, still 60s')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Demo mode'), 'valueChange', false);

    // The engine is back on real inputs, not merely hidden.
    await waitFor(() =>
      expect(screen.getByText('No fall or unusual stillness detected.')).toBeTruthy(),
    );
    expect(screen.getByText('Heat conditions are comfortable.')).toBeTruthy();
    // The Dashboard's controls are gone with it. ("Demo mode" itself still appears — it is the
    // Settings row's own title, which is how the user would turn it back on.)
    expect(screen.queryByText(FALL_CONTROL)).toBeNull();
    expect(screen.queryByText(HEAT_CONTROL)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Nothing simulated is ever persisted
// ---------------------------------------------------------------------------

/**
 * The guarantee printed in the Settings copy: "Simulated readings are never saved to your
 * history."
 *
 * It holds structurally — `useSensors` is the only writer, and the splice happens downstream of
 * it in `useRiskAssessment` — but "holds structurally" is exactly the kind of claim that stops
 * being true the first time someone moves the splice upstream to simplify something. So it is
 * asserted at the boundary it would have to cross: `store.append`.
 */
describe('simulated readings never reach the reading store', () => {
  it('never touches the store at all on the simulated source', async () => {
    await seedSettings({ demoMode: true, sensorSource: 'simulated' });

    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(FALL_CONTROL)).toBeTruthy());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await fireEvent.press(screen.getByText(FALL_CONTROL));
    await waitFor(() => expect(screen.getByText('Impact 3.1g, still 60s')).toBeTruthy());

    expect(readingStore.append).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it('persists only what Health Connect actually returned, with both controls armed', async () => {
    // The harder case: a live feed *is* writing, so "nothing was written" would be a vacuous
    // pass. The store must receive the real reading and nothing else.
    jest.mocked(checkHealthConnect).mockResolvedValue('available');
    jest.mocked(grantedVitalsPermissions).mockResolvedValue(['HeartRate']);
    const real: SensorReading = { source: 'health_connect', timestamp: NOW - 30_000, hr: 88 };
    jest.mocked(readVitals).mockResolvedValue([real]);
    jest.mocked(isMotionAvailable).mockResolvedValue(true);
    jest.mocked(startMotionFold).mockReturnValue({
      flush: () => ({ peakG: 1.04, minG: 0.97, rmsG: 1.0, sampleCount: 60 }),
      stop: () => {},
    } as unknown as MotionFold);

    await seedSettings({ demoMode: true, sensorSource: 'health_connect' });

    const screen = await renderHome();
    await waitFor(() => expect(screen.getByText(FALL_CONTROL)).toBeTruthy());
    await waitFor(() => expect(readingStore.append).toHaveBeenCalled());

    await fireEvent.press(screen.getByText(HEAT_CONTROL));
    await fireEvent.press(screen.getByText(FALL_CONTROL));

    // The fall really is being detected off the spliced live buffer, so the demo is armed and
    // working — which is what makes the assertion below meaningful rather than trivially true.
    await waitFor(() => expect(screen.getByText(/^Impact 3\.1g/)).toBeTruthy());

    // Not one reading with the simulated provenance, and not one carrying the injected impact.
    expect(appended.filter((reading) => reading.source === 'simulated')).toEqual([]);
    expect(appended.filter((reading) => reading.motionSummary?.peakG === 3.1)).toEqual([]);
    // And the real reading did go through, so the store is genuinely in the path.
    expect(appended).toContainEqual(real);
  });
});
