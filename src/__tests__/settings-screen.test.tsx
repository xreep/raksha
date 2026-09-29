/**
 * Settings screen tests.
 *
 * The screen was a placeholder with hardcoded rows until SOS became real. What makes it worth
 * testing now is that it is the *only* place a user can put a phone number into the send path,
 * and the failure it has to prevent is silent: a number saved without a country code, or saved
 * to state but never to disk, looks correct on screen and is discovered during an emergency.
 *
 * So these tests are about persistence and about the country-code refusal, not about layout.
 * Each one drives the real `SettingsProvider` over the real store against the AsyncStorage jest
 * mock, then asserts through a *fresh* mount — a remount is the only way to tell "saved" from
 * "still in component state".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getAlertPermission, requestAlertPermission } from '@/alerts/notify';
import { AlertsProvider } from '@/alerts/provider';
import SettingsScreen from '@/app/settings';
import { SettingsProvider } from '@/settings/provider';
import { readSettings, SETTINGS_KEY } from '@/settings/store';
import { MemoryReadingStore } from '@/store/memory';
import { ReadingStoreProvider } from '@/store/provider';
import { openSqliteReadingStore } from '@/store/sqlite';

// `@/alerts/notify` talks to `expo-notifications`; the screen's own concern (through the real
// `AlertsProvider`, wrapped below — see that module's doc for why permission is shared state
// rather than a private read here) is only whether the right function gets called at the right
// moment and the screen reacts to what comes back, so the native-facing module is mocked
// directly rather than driven through the (also-mocked) native module two layers down.
jest.mock('@/alerts/notify', () => ({
  ensureAlertChannels: jest.fn(() => Promise.resolve()),
  getAlertPermission: jest.fn(() => Promise.resolve('undetermined')),
  requestAlertPermission: jest.fn(() => Promise.resolve('undetermined')),
}));

// Only the "store not ready yet" test needs this: `renderSettings` injects a memory store (ready
// at once), so the one way to observe the pre-open window is a real provider whose SQLite open
// never settles.
jest.mock('@/store/sqlite', () => ({
  ...jest.requireActual('@/store/sqlite'),
  openSqliteReadingStore: jest.fn(),
}));

const mockedGetAlertPermission = jest.mocked(getAlertPermission);
const mockedRequestAlertPermission = jest.mocked(requestAlertPermission);
const mockedOpenSqlite = jest.mocked(openSqliteReadingStore);

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * In react-native-testing-library v14, **every** interaction is async: `render`, `fireEvent`,
 * `unmount`, and `rerender` all return promises and all must be awaited.
 *
 * The failure modes are each misleading in a different way, which is why this is written down:
 * an unawaited `render` yields a promise whose `getByText` is `undefined`, so assertions fail on
 * "not a function"; an unawaited `fireEvent` fires the handler but never flushes the re-render,
 * so the screen looks as though the press did nothing; and an unawaited `unmount` leaves an act
 * scope open, which breaks *every subsequent test in the file* with an "overlapping act() calls"
 * warning and empty renders. The last one is the expensive one — the symptom appears in tests
 * that are themselves correct.
 */
function renderSettings() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <SettingsProvider>
        {/* A known memory store, so "Erase my health data" has something real to erase and the
            test can count what is left. */}
        <ReadingStoreProvider store={readingStore}>
          <AlertsProvider>
            <SettingsScreen />
          </AlertsProvider>
        </ReadingStoreProvider>
      </SettingsProvider>
    </SafeAreaProvider>,
  );
}

const originalRelay = process.env.EXPO_PUBLIC_SOS_RELAY_URL;
const originalLegacyRelay = process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
const originalFetch = globalThis.fetch;
let readingStore: MemoryReadingStore;

beforeEach(async () => {
  await AsyncStorage.clear();
  readingStore = new MemoryReadingStore();
  mockedOpenSqlite.mockReset().mockRejectedValue(new Error('no sqlite under test'));
  delete process.env.EXPO_PUBLIC_SOS_RELAY_URL;
  delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
  mockedGetAlertPermission.mockReset().mockResolvedValue('undetermined');
  mockedRequestAlertPermission.mockReset().mockResolvedValue('undetermined');
});

afterEach(() => {
  if (originalRelay === undefined) delete process.env.EXPO_PUBLIC_SOS_RELAY_URL;
  else process.env.EXPO_PUBLIC_SOS_RELAY_URL = originalRelay;
  if (originalLegacyRelay === undefined) delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
  else process.env.EXPO_PUBLIC_TWILIO_SOS_URL = originalLegacyRelay;
  globalThis.fetch = originalFetch;
});

const RELAY = 'https://phc-sos-relay.example.workers.dev';

/**
 * The relay behind the screen's own `fetch` — the editor is rendered by the real Settings screen
 * with no injection point, so the global is replaced for the test. `/health` names the bot;
 * `/link` answers 404 `pending` times, then the chat id. Nothing else is reachable.
 */
function installRelay({ chatId = '123456789', hold = false }: { chatId?: string; hold?: boolean } = {}) {
  // With `hold`, `/link` does not answer until `release()` — the only way to observe the
  // "waiting" state under real timers, since the first poll is immediate.
  let release: () => void = () => undefined;
  const gate = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const fetchImpl = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      ({ ok: status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;
    if (url === `${RELAY}/health`) return json(200, { ok: true, botUsername: 'phc_sos_bot', linking: true });
    if (url === `${RELAY}/link`) {
      await gate;
      return json(200, { telegramChatId: chatId });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return { fetchImpl, release: () => release() };
}

/** Open the add-contact sheet and fill it in. */
async function addContact(
  screen: Awaited<ReturnType<typeof renderSettings>>,
  fields: { name: string; relation?: string; phone: string },
) {
  await fireEvent.press(screen.getByText('+ Add emergency contact'));

  await fireEvent.changeText(screen.getByLabelText('Contact name'), fields.name);
  if (fields.relation !== undefined) {
    await fireEvent.changeText(screen.getByLabelText('Relationship'), fields.relation);
  }
  await fireEvent.changeText(screen.getByLabelText('Phone number'), fields.phone);
}

describe('emergency contacts', () => {
  it('says plainly that there is nowhere to send, rather than showing an empty list', async () => {
    // The honest default. Seeding demo numbers here would have texted a stranger on the first
    // press, and showing a blank card would leave the user thinking SOS was ready.
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'No contacts yet. Emergency SOS has nowhere to send until you add at least one.',
        ),
      ).toBeTruthy(),
    );
  });

  it('adds a contact and persists it, not just to component state', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', relation: 'Sister', phone: '+91 98765 43210' });
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());
    expect(screen.getByText('Sister · +91 98765 43210')).toBeTruthy();

    // The assertion that matters: it reached storage, normalized. A contact list that lives only
    // in component state resets with the process and cannot be relied on in an emergency.
    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toEqual([
        { id: expect.any(String), name: 'Meera', relation: 'Sister', phone: '+919876543210' },
      ]);
    });
  });

  it('shows a saved contact on a fresh mount', async () => {
    const first = await renderSettings();
    await waitFor(() => expect(first.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(first, { name: 'Ravi', phone: '+919123456780' });
    await fireEvent.press(first.getByText('Save contact'));
    await waitFor(() => expect(first.getByText('Ravi')).toBeTruthy());
    await first.unmount();

    const second = await renderSettings();

    await waitFor(() => expect(second.getByText('Ravi')).toBeTruthy());
    // No relation given, so the row shows the number alone rather than a leading separator.
    expect(second.getByText('+91 91234 56780')).toBeTruthy();
  });

  it('refuses a number with no country code and explains why', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', phone: '9876543210' });

    // The explanation, not just a disabled button: the user is meeting a deliberate refusal and
    // needs to know it is not a bug.
    expect(
      screen.getByText(
        'Include the country code, for example +91 for India. SOS will not guess it — a wrong code sends the alert to a stranger.',
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByText('Save contact'));

    // Nothing saved, and the sheet stays open so the number can be fixed.
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
    await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
  });

  it('echoes back the number that will actually be dialled', async () => {
    // The only feedback available short of sending a test message, and the typo it catches is
    // otherwise silent until an emergency.
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', phone: '00919876543210' });

    expect(screen.getByText('Will send to +91 98765 43210')).toBeTruthy();
  });

  it('edits a contact in place rather than adding a second one', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', relation: 'Sister', phone: '+919876543210' });
    await fireEvent.press(screen.getByText('Save contact'));
    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());

    await fireEvent.press(screen.getByText('Meera'));
    // Seeded with the stored E.164, so an edit round-trip cannot quietly change the number.
    expect(screen.getByLabelText('Phone number').props.value).toBe('+919876543210');
    await fireEvent.changeText(screen.getByLabelText('Contact name'), 'Meera S.');
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toHaveLength(1);
      expect(stored.contacts[0].name).toBe('Meera S.');
      expect(stored.contacts[0].phone).toBe('+919876543210');
    });
  });

  it('removes a contact', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', phone: '+919876543210' });
    await fireEvent.press(screen.getByText('Save contact'));
    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());

    await fireEvent.press(screen.getByText('Meera'));
    await fireEvent.press(screen.getByText('Remove contact'));

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
    });
    expect(
      screen.getByText(
        'No contacts yet. Emergency SOS has nowhere to send until you add at least one.',
      ),
    ).toBeTruthy();
  });

  it('offers no delete on a contact that does not exist yet', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await fireEvent.press(screen.getByText('+ Add emergency contact'));

    expect(screen.getByText('Add emergency contact')).toBeTruthy();
    expect(screen.queryByText('Remove contact')).toBeNull();
  });
});

describe('telegram linking', () => {
  // The token the global expo-crypto mock's bytes encode to (pinned in telegram-link.test.ts).
  const TOKEN = 'CzBVep_E6Q4zWH2ix-wRNg';

  it('says linking is unavailable when no relay is configured, and still saves by SMS', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await fireEvent.press(screen.getByText('+ Add emergency contact'));

    expect(
      screen.getByText(
        'Relay not configured — Telegram linking needs EXPO_PUBLIC_SOS_RELAY_URL. SMS still works.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Link Telegram')).toBeNull();
  });

  it('links a contact: bot name from /health, the deep link on screen, the chat id from /link, the badge after save', async () => {
    process.env.EXPO_PUBLIC_SOS_RELAY_URL = `${RELAY}/sos`;
    const { fetchImpl, release } = installRelay({ hold: true });
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });

    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', relation: 'Sister', phone: '+919876543210' });

    await fireEvent.press(screen.getByText('Link Telegram'));

    // The link, built from the bot `/health` named and the app-made token — and the manual
    // `/start` recovery for clients that drop the payload.
    await waitFor(() =>
      expect(screen.getByLabelText('Telegram link').props.children).toBe(
        `https://t.me/phc_sos_bot?start=${TOKEN}`,
      ),
    );
    expect(screen.getByText(/They tap it in Telegram and press Start/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`/start ${TOKEN} to @phc_sos_bot`))).toBeTruthy();
    expect(screen.getByText(/Waiting for the contact to press Start/)).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(`${RELAY}/health`, expect.objectContaining({ method: 'GET' }));

    // Share goes through the platform sheet with the link and the instructions.
    await fireEvent.press(screen.getByText('Share link'));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].message).toContain(`https://t.me/phc_sos_bot?start=${TOKEN}`);

    // The relay answers `/link` with the chat id (the first poll was immediate; it was held).
    await act(async () => release());
    await waitFor(() => expect(screen.getByText(/^Linked ✓/)).toBeTruthy());
    const linkCall = fetchImpl.mock.calls.find(([input]) => String(input) === `${RELAY}/link`);
    expect(linkCall).toBeDefined();
    expect(JSON.parse(String(linkCall?.[1]?.body))).toEqual({ linkToken: TOKEN });

    // Not stored until saved — the copy says so.
    expect(screen.getByText(/Save the contact to keep it/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toEqual([
        expect.objectContaining({ name: 'Meera', phone: '+919876543210', telegramChatId: '123456789' }),
      ]);
    });
    // And the list shows it.
    expect(screen.getByText('Telegram')).toBeTruthy();
    expect(screen.getByLabelText('Meera: Telegram linked')).toBeTruthy();
    share.mockRestore();
  });

  it('shows the badge for a contact linked in an earlier session', async () => {
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        contacts: [
          { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210', telegramChatId: '123456789' },
          { id: 'c2', name: 'Ravi', relation: '', phone: '+919123456780' },
        ],
      }),
    );

    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByLabelText('Meera: Telegram linked')).toBeTruthy());
    expect(screen.queryByLabelText('Ravi: Telegram linked')).toBeNull();
    expect(screen.getAllByText('Telegram')).toHaveLength(1);
  });

  it('unlinks by clearing the field on save', async () => {
    process.env.EXPO_PUBLIC_SOS_RELAY_URL = `${RELAY}/sos`;
    installRelay();
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        contacts: [
          { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210', telegramChatId: '123456789' },
        ],
      }),
    );
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());

    await fireEvent.press(screen.getByText('Meera'));
    expect(screen.getByText(/^Linked ✓/)).toBeTruthy();
    // A link stored in an earlier session is already saved; telling the user to save it would
    // be false, and is the sentence reserved for a link that is still a draft.
    expect(screen.queryByText(/Save the contact to keep it/)).toBeNull();
    await fireEvent.press(screen.getByText('Unlink Telegram'));
    expect(screen.getByText('Link Telegram')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toEqual([
        { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210' },
      ]);
    });
    expect(screen.queryByLabelText('Meera: Telegram linked')).toBeNull();
  });

  it('discards an unsaved link on cancel', async () => {
    // "Linked ✓" in the editor is a draft. The store never heard about it until Save, and the
    // list must not show a badge for a link the user backed out of.
    process.env.EXPO_PUBLIC_SOS_RELAY_URL = `${RELAY}/sos`;
    installRelay();
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', phone: '+919876543210' });

    await fireEvent.press(screen.getByText('Link Telegram'));
    await waitFor(() => expect(screen.getByText(/^Linked ✓/)).toBeTruthy());
    await fireEvent.press(screen.getByText('Cancel'));

    await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
    expect(screen.queryByText('Telegram')).toBeNull();
  });
});

describe('your name', () => {
  it('persists on blur, trimmed', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeTruthy());

    await fireEvent.changeText(screen.getByLabelText('Your name'), '  Asha  ');
    await fireEvent(screen.getByLabelText('Your name'), 'blur');

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ userName: 'Asha' });
    });
  });

  it('shows the stored name once storage resolves', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ userName: 'Asha' }));

    const screen = await renderSettings();

    // The `nameDraft: string | null` pattern exists for this: a draft initialised to `''` would
    // render empty and then be committed over the stored value on the first blur.
    await waitFor(() => expect(screen.getByLabelText('Your name').props.value).toBe('Asha'));
  });
});

describe('how SOS sends', () => {
  it('says the relay is unconfigured, and what that means for the user', async () => {
    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByText('Automatic relay: not configured')).toBeTruthy());
    expect(
      screen.getByText(
        'Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local to send automatically. Until then SOS opens your SMS app with the message ready — you press send.',
      ),
    ).toBeTruthy();
  });

  it('says the relay is configured, and which channels that means', async () => {
    process.env.EXPO_PUBLIC_SOS_RELAY_URL = 'https://phc-sos-relay.example.workers.dev/sos';

    const screen = await renderSettings();

    await waitFor(() =>
      expect(screen.getByText('Automatic relay: configured (Telegram + SMS gateway)')).toBeTruthy(),
    );
  });

  it('still reads the legacy variable name for one release', async () => {
    // A `.env.local` written for the Twilio-only build keeps the relay configured.
    process.env.EXPO_PUBLIC_TWILIO_SOS_URL = 'https://phc-1234.twil.io/sos';

    const screen = await renderSettings();

    await waitFor(() =>
      expect(screen.getByText('Automatic relay: configured (Telegram + SMS gateway)')).toBeTruthy(),
    );
  });

  it('states the composer limitation in calm conditions', async () => {
    // It cannot be discovered during an emergency, so it is said here, where there is time to
    // read it.
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'The SMS fallback works without mobile data, but it always needs you to press send — Android and iOS never let an app send a text on its own.',
        ),
      ).toBeTruthy(),
    );
  });
});

describe('data sharing', () => {
  it('persists a toggle', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Anonymous community insights')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Anonymous community insights'), 'valueChange', true);

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.sharing.anon_aggregate).toBe(true);
    });
  });

  it('persists turning the SOS opt-in off', async () => {
    // PRD §7.2.6's consent gate. It has to survive a remount to mean anything — an opt-out that
    // resets on restart is not consent management, it is a toggle.
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Emergency SOS alerts')).toBeTruthy());
    expect(screen.getByLabelText('Emergency SOS alerts').props.value).toBe(true);

    await fireEvent(screen.getByLabelText('Emergency SOS alerts'), 'valueChange', false);

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ sharing: { sos: false } });
    });

    await screen.unmount();
    const second = await renderSettings();
    await waitFor(() =>
      expect(second.getByLabelText('Emergency SOS alerts').props.value).toBe(false),
    );
  });

  it('says what turning SOS off actually stops, and what SOS itself sends', async () => {
    const screen = await renderSettings();

    // The sentence used to read "No raw health data leaves your device", directly under the SOS
    // toggle. That was false: `composeSosMessage` puts the user's name, HR, SpO2, skin
    // temperature, heat index and GPS coordinates into the outgoing body, and `sos-flow.test.tsx`
    // asserts all of it going over the relay. A privacy claim sitting beside the one control that
    // contradicts it is the worst place for one to be wrong, so the copy now names the exception.
    await waitFor(() =>
      expect(
        screen.getByText(
          'All sharing is off by default except emergency SOS, which is the one path that sends anything off this device: an SOS carries your name, your latest vitals, and your coordinates to the contacts you have added, through your SMS app or your configured relay. Nothing else is uploaded anywhere. Turning off emergency SOS stops the app alerting your contacts at all, including automatically.',
        ),
      ).toBeTruthy(),
    );

    // And the retired claim is gone rather than merely moved.
    expect(screen.queryByText(/No raw health data leaves your device/)).toBeNull();
  });
});

describe('erase my health data (M6)', () => {
  // The reading store persists real vitals in plaintext, app-private storage (ADR-006), so a
  // way to erase it ships with it. The control is destructive and irreversible, hence the
  // confirm; and it must leave settings and contacts alone — a user clearing readings must not
  // lose the emergency contact list.
  const READINGS = [
    { source: 'health_connect' as const, timestamp: 1_766_000_000_000, hr: 72 },
    { source: 'health_connect' as const, timestamp: 1_766_000_060_000, spo2: 97 },
  ];

  function buttons(alert: jest.SpyInstance): AlertButton[] {
    const call = alert.mock.calls.at(-1);
    return (call?.[2] ?? []) as AlertButton[];
  }

  it('shows the row with honest copy about what it deletes and what it keeps', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    expect(
      screen.getByText('Deletes all readings stored on this phone. Settings and contacts are kept.'),
    ).toBeTruthy();
  });

  it('is disabled, and never reaches the confirm, while the store is still opening', async () => {
    // Before the SQLite open settles the provider serves a memory placeholder. An erase
    // confirmed in that window would clear the placeholder and print "Readings erased." while
    // `phc.db` sat untouched — a false privacy claim — so the row waits for `ready`.
    mockedOpenSqlite.mockReturnValue(new Promise(() => {}));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await render(
      <SafeAreaProvider initialMetrics={INSETS}>
        <SettingsProvider>
          <ReadingStoreProvider>
            <AlertsProvider>
              <SettingsScreen />
            </AlertsProvider>
          </ReadingStoreProvider>
        </SettingsProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    await waitFor(() => expect(mockedOpenSqlite).toHaveBeenCalledTimes(1));

    const row = screen.getByLabelText('Erase my health data');
    expect(row.props.accessibilityState).toEqual({ disabled: true });

    await fireEvent.press(row);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('is enabled once the store is ready', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    expect(screen.getByLabelText('Erase my health data').props.accessibilityState).toEqual({
      disabled: false,
    });
  });

  it('asks for confirmation first and erases nothing until it is given', async () => {
    await readingStore.append(READINGS);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());

    await fireEvent.press(screen.getByText('Erase my health data'));

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('Erase my health data?');
    expect(alert.mock.calls[0][1]).toBe(
      'Deletes all readings stored on this phone. Settings and contacts are kept.',
    );
    await expect(readingStore.count()).resolves.toBe(2);
    alert.mockRestore();
  });

  it('keeps everything when the confirm is cancelled', async () => {
    await readingStore.append(READINGS);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    await fireEvent.press(screen.getByText('Erase my health data'));

    const cancel = buttons(alert).find((b) => b.style === 'cancel');
    expect(cancel?.text).toBe('Cancel');
    await act(async () => {
      cancel?.onPress?.();
    });

    await expect(readingStore.count()).resolves.toBe(2);
    alert.mockRestore();
  });

  it('clears the store on confirm and leaves settings and contacts untouched', async () => {
    await readingStore.append(READINGS);
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        userName: 'Asha',
        contacts: [{ id: 'c1', name: 'Ravi', relation: 'Brother', phone: '+919876543210' }],
      }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Ravi')).toBeTruthy());
    await fireEvent.press(screen.getByText('Erase my health data'));

    const erase = buttons(alert).find((b) => b.style === 'destructive');
    expect(erase?.text).toBe('Erase');
    await act(async () => {
      erase?.onPress?.();
    });

    await waitFor(async () => {
      await expect(readingStore.count()).resolves.toBe(0);
    });
    await expect(readSettings()).resolves.toMatchObject({
      userName: 'Asha',
      contacts: [{ name: 'Ravi', phone: '+919876543210' }],
    });
    expect(screen.getByText('Ravi')).toBeTruthy();
    alert.mockRestore();
  });

  it('reports a store that could not be erased rather than pretending it was', async () => {
    jest.spyOn(readingStore, 'clear').mockRejectedValue(new Error('database is locked'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    await fireEvent.press(screen.getByText('Erase my health data'));

    const erase = buttons(alert).find((b) => b.style === 'destructive');
    await act(async () => {
      erase?.onPress?.();
    });

    await waitFor(() =>
      expect(screen.getByText('Could not erase readings — try again.')).toBeTruthy(),
    );
    alert.mockRestore();
  });

  it('confirms on screen once the readings are gone', async () => {
    await readingStore.append(READINGS);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('Erase my health data')).toBeTruthy());
    await fireEvent.press(screen.getByText('Erase my health data'));
    const erase = buttons(alert).find((b) => b.style === 'destructive');
    await act(async () => {
      erase?.onPress?.();
    });

    await waitFor(() => expect(screen.getByText('Readings erased.')).toBeTruthy());
    alert.mockRestore();
  });
});

/**
 * Demo mode (workstream I1).
 *
 * The row is a switch like any other, so the persistence assertions look like the ones above.
 * What is *not* routine is the description: it is the only place a user is told, in calm
 * conditions, what turning this on will put on their Dashboard and what it will not do to their
 * history. It is asserted verbatim for the same reason the SOS copy is — a health app's honesty
 * claims are part of the feature, and prose quietly softened in a later edit is exactly the
 * change no behavioural test would catch.
 */
describe('demo mode', () => {
  const DEMO_DESCRIPTION =
    'Adds buttons to the Dashboard that inject simulated sensor readings so the risk engine can be demonstrated. A "Demo mode" label stays on screen while it is on. Simulated readings are never saved to your history.';

  it('is off by default, and says exactly what it does', async () => {
    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByLabelText('Demo mode')).toBeTruthy());
    expect(screen.getByLabelText('Demo mode').props.value).toBe(false);
    expect(screen.getByText(DEMO_DESCRIPTION)).toBeTruthy();
  });

  it('persists turning it on', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Demo mode')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Demo mode'), 'valueChange', true);

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ demoMode: true });
    });
  });

  it('persists turning it back off', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ demoMode: true }));

    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Demo mode').props.value).toBe(true));

    await fireEvent(screen.getByLabelText('Demo mode'), 'valueChange', false);

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ demoMode: false });
    });
  });

  it('survives a remount, so the state on screen is the state on disk', async () => {
    const first = await renderSettings();
    await waitFor(() => expect(first.getByLabelText('Demo mode')).toBeTruthy());
    await fireEvent(first.getByLabelText('Demo mode'), 'valueChange', true);
    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ demoMode: true });
    });
    await first.unmount();

    const second = await renderSettings();

    await waitFor(() => expect(second.getByLabelText('Demo mode').props.value).toBe(true));
  });
});

describe('about you', () => {
  it('says plainly why it is asking and that it never leaves the device', async () => {
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText('Used to tailor risk warnings on this phone. Never sent anywhere.'),
      ).toBeTruthy(),
    );
  });

  it('defaults every toggle off', async () => {
    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByLabelText('Pregnant')).toBeTruthy());
    expect(screen.getByLabelText('Long-term health condition').props.value).toBe(false);
    expect(screen.getByLabelText('Works outdoors').props.value).toBe(false);
    expect(screen.getByLabelText('Pregnant').props.value).toBe(false);
  });

  it('persists the selected age band', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('60 and over')).toBeTruthy());

    await fireEvent.press(screen.getByText('60 and over'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.profile.ageBand).toBe('60plus');
    });
  });

  it('switches the selection rather than allowing two bands at once', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('60 and over')).toBeTruthy());

    await fireEvent.press(screen.getByText('60 and over'));
    await fireEvent.press(screen.getByText('Under 18'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.profile.ageBand).toBe('under18');
    });
  });

  it('persists a toggle', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Works outdoors')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Works outdoors'), 'valueChange', true);

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.profile.outdoorWorker).toBe(true);
    });
  });

  it('toggles chronic condition and pregnant independently of each other and of the age band', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Pregnant')).toBeTruthy());

    await fireEvent.press(screen.getByText('40–59'));
    await fireEvent(screen.getByLabelText('Long-term health condition'), 'valueChange', true);
    await fireEvent(screen.getByLabelText('Pregnant'), 'valueChange', true);

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.profile).toEqual({
        ageBand: '40to59',
        chronicCondition: true,
        outdoorWorker: false,
        pregnant: true,
      });
    });
  });

  it('shows a saved profile on a fresh mount', async () => {
    const first = await renderSettings();
    await waitFor(() => expect(first.getByText('60 and over')).toBeTruthy());
    await fireEvent.press(first.getByText('60 and over'));
    await fireEvent(first.getByLabelText('Pregnant'), 'valueChange', true);
    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.profile).toMatchObject({ ageBand: '60plus', pregnant: true });
    });
    await first.unmount();

    const second = await renderSettings();

    await waitFor(() => expect(second.getByLabelText('Pregnant').props.value).toBe(true));
  });
});

describe('sensor source', () => {
  it('persists the selection', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('ESP32 Prototype (BLE)')).toBeTruthy());

    await fireEvent.press(screen.getByText('ESP32 Prototype (BLE)'));

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ sensorSource: 'ble_esp32' });
    });
  });
});

describe('alert notifications', () => {
  it('is on by default', async () => {
    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByLabelText('Alert notifications').props.value).toBe(true));
  });

  it('persists turning it off, without touching the OS permission', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Alert notifications')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Alert notifications'), 'valueChange', false);

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ alerts: { enabled: false } });
    });
    expect(mockedRequestAlertPermission).not.toHaveBeenCalled();
  });

  it('requests the OS permission when turned on, user-initiated', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ alerts: { enabled: false } }));
    mockedRequestAlertPermission.mockResolvedValue('granted');

    const screen = await renderSettings();
    await waitFor(() =>
      expect(screen.getByLabelText('Alert notifications').props.value).toBe(false),
    );

    await fireEvent(screen.getByLabelText('Alert notifications'), 'valueChange', true);

    await waitFor(() => expect(mockedRequestAlertPermission).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ alerts: { enabled: true } });
    });
  });

  it('says notifications are blocked when the OS permission comes back denied', async () => {
    mockedRequestAlertPermission.mockResolvedValue('denied');

    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Alert notifications')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Alert notifications'), 'valueChange', true);

    await waitFor(() =>
      expect(
        screen.getByText(
          'Notifications are blocked for this app — enable them in Android settings.',
        ),
      ).toBeTruthy(),
    );
  });

  it('shows the blocked notice on load too, from a permission already denied earlier', async () => {
    mockedGetAlertPermission.mockResolvedValue('denied');

    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'Notifications are blocked for this app — enable them in Android settings.',
        ),
      ).toBeTruthy(),
    );
  });

  it('does not show the blocked notice while permission is merely undetermined', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Alert notifications')).toBeTruthy());

    expect(
      screen.queryByText('Notifications are blocked for this app — enable them in Android settings.'),
    ).toBeNull();
  });

  describe('a fresh install — toggle on by default, OS permission not yet asked', () => {
    // DEFAULT_SETTINGS.alerts.enabled is true, so a brand-new Android 13+ install lands on this
    // screen with the toggle already on and the OS permission still 'undetermined' — nobody has
    // been asked yet, and 'undetermined' alone renders no hint. Without a user-initiated way to
    // ask right here, the toggle's promise is never actually kept.
    it('offers a user-initiated way to turn notifications on', async () => {
      const screen = await renderSettings();

      await waitFor(() => expect(screen.getByText('Turn on notifications')).toBeTruthy());
    });

    it('requests permission when that prompt is pressed', async () => {
      mockedRequestAlertPermission.mockResolvedValue('granted');
      const screen = await renderSettings();
      await waitFor(() => expect(screen.getByText('Turn on notifications')).toBeTruthy());

      await fireEvent.press(screen.getByText('Turn on notifications'));

      await waitFor(() => expect(mockedRequestAlertPermission).toHaveBeenCalledTimes(1));
    });

    it('hides the prompt once permission is granted', async () => {
      mockedRequestAlertPermission.mockResolvedValue('granted');
      const screen = await renderSettings();
      await waitFor(() => expect(screen.getByText('Turn on notifications')).toBeTruthy());

      await fireEvent.press(screen.getByText('Turn on notifications'));

      await waitFor(() => expect(screen.queryByText('Turn on notifications')).toBeNull());
    });

    it('does not offer the prompt while the toggle itself is off', async () => {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ alerts: { enabled: false } }));

      const screen = await renderSettings();

      await waitFor(() =>
        expect(screen.getByLabelText('Alert notifications').props.value).toBe(false),
      );
      expect(screen.queryByText('Turn on notifications')).toBeNull();
    });
  });
});

describe('a failed write', () => {
  it('warns rather than silently forgetting a contact the user believes is saved', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));

    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await act(async () => {
      await fireEvent(screen.getByLabelText('Emergency SOS alerts'), 'valueChange', false);
    });

    await waitFor(() => expect(screen.getByText('Changes could not be saved')).toBeTruthy());
    expect(
      screen.getByText(
        'Device storage rejected the write, so anything you change here will be lost when the app restarts. Free up space and reopen Settings.',
      ),
    ).toBeTruthy();

    jest.restoreAllMocks();
  });
});
