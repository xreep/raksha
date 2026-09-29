/**
 * `AlertsProvider` tests.
 *
 * This is the fix for review round 1's CRITICAL #1: permission used to be read independently by
 * `useAlerts` and by the Settings screen, so a grant made in one never reached the other while
 * Expo Router kept both mounted. What matters here is exactly what that bug was about — one
 * shared value, refreshed at the right moments — not the mocked `expo-notifications` calls
 * themselves, which `src/alerts/__tests__/notify.test.ts` already covers.
 *
 * `@/settings/provider` is mocked module-wide (the same convention
 * `src/hooks/__tests__/use-risk-assessment.test.ts` uses) so `settings.alerts.enabled` can be
 * moved between renders without driving a real `SettingsProvider` through storage.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { ensureAlertChannels, getAlertPermission, requestAlertPermission } from '@/alerts/notify';
import { AlertsProvider, useAlertPermission } from '@/alerts/provider';
import { useSettings } from '@/settings/provider';
import { DEFAULT_SETTINGS } from '@/settings/store';

jest.mock('@/alerts/notify', () => ({
  ensureAlertChannels: jest.fn(() => Promise.resolve()),
  getAlertPermission: jest.fn(() => Promise.resolve('undetermined')),
  requestAlertPermission: jest.fn(() => Promise.resolve('undetermined')),
}));
jest.mock('@/settings/provider', () => ({ useSettings: jest.fn() }));

const mockedEnsureChannels = jest.mocked(ensureAlertChannels);
const mockedGetPermission = jest.mocked(getAlertPermission);
const mockedRequestPermission = jest.mocked(requestAlertPermission);
const mockedUseSettings = jest.mocked(useSettings);

function settingsStoreWith(alertsEnabled: boolean) {
  return {
    settings: { ...DEFAULT_SETTINGS, alerts: { enabled: alertsEnabled } },
    loaded: true,
    writeFailed: false,
    addContact: jest.fn(),
    removeContact: jest.fn(),
    setUserName: jest.fn(),
    setSharing: jest.fn(),
    setSensorSource: jest.fn(),
    setAlertsEnabled: jest.fn(),
    setDemoMode: jest.fn(),
    setProfile: jest.fn(),
  };
}

let appStateHandlers: ((status: AppStateStatus) => void)[] = [];

async function emitAppState(status: AppStateStatus) {
  await act(async () => {
    for (const handler of appStateHandlers) handler(status);
  });
}

beforeEach(() => {
  mockedEnsureChannels.mockReset().mockResolvedValue(undefined);
  mockedGetPermission.mockReset().mockResolvedValue('undetermined');
  mockedRequestPermission.mockReset().mockResolvedValue('undetermined');
  mockedUseSettings.mockReturnValue(settingsStoreWith(true));

  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useAlertPermission', () => {
  it('throws outside an AlertsProvider', async () => {
    // React logs the render failure itself; the assertion is about the throw, not the log.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useAlertPermission())).rejects.toThrow(
      /inside an <AlertsProvider>/,
    );
    spy.mockRestore();
  });

  it('creates the notification channels and reads the current permission, once, on mount', async () => {
    const { result } = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });

    expect(mockedEnsureChannels).toHaveBeenCalledTimes(1);
    expect(mockedGetPermission).toHaveBeenCalledTimes(1);
    expect(mockedRequestPermission).not.toHaveBeenCalled();
    expect(result.current.permission).toBe('undetermined');
  });

  it('updates permission once requestPermission resolves', async () => {
    mockedRequestPermission.mockResolvedValue('granted');
    const { result } = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });

    await act(async () => {
      result.current.requestPermission();
      await Promise.resolve();
    });

    expect(mockedRequestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.permission).toBe('granted');
  });

  it('re-reads permission when the app returns to the foreground', async () => {
    mockedGetPermission.mockResolvedValueOnce('undetermined').mockResolvedValueOnce('granted');
    const { result } = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });
    expect(result.current.permission).toBe('undetermined');

    await emitAppState('active');

    // Covers both the OS permission dialog itself backgrounding/foregrounding the app, and a
    // user who grants the permission from Android's own notification settings and returns.
    expect(mockedGetPermission).toHaveBeenCalledTimes(2);
    expect(result.current.permission).toBe('granted');
  });

  it('ignores transitions other than becoming active', async () => {
    await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });
    expect(mockedGetPermission).toHaveBeenCalledTimes(1);

    await emitAppState('background');
    await emitAppState('inactive');

    expect(mockedGetPermission).toHaveBeenCalledTimes(1);
  });

  it('re-reads permission when the Settings toggle flips from off to on', async () => {
    mockedUseSettings.mockReturnValue(settingsStoreWith(false));
    mockedGetPermission.mockResolvedValueOnce('undetermined').mockResolvedValueOnce('granted');

    const view = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });
    expect(mockedGetPermission).toHaveBeenCalledTimes(1);
    expect(view.result.current.permission).toBe('undetermined');

    mockedUseSettings.mockReturnValue(settingsStoreWith(true));
    await view.rerender(undefined);

    expect(mockedGetPermission).toHaveBeenCalledTimes(2);
    expect(view.result.current.permission).toBe('granted');
  });

  it('does not re-read on a render where the toggle stays on', async () => {
    const view = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });
    expect(mockedGetPermission).toHaveBeenCalledTimes(1);

    // `settingsStoreWith(true)` again — a genuinely new object each call, same as a real
    // `SettingsProvider` re-render, but `enabled` itself has not changed value.
    mockedUseSettings.mockReturnValue(settingsStoreWith(true));
    await view.rerender(undefined);

    expect(mockedGetPermission).toHaveBeenCalledTimes(1);
  });

  it('does not re-read when the toggle flips from on to off', async () => {
    const view = await renderHook(() => useAlertPermission(), { wrapper: AlertsProvider });
    expect(mockedGetPermission).toHaveBeenCalledTimes(1);

    mockedUseSettings.mockReturnValue(settingsStoreWith(false));
    await view.rerender(undefined);

    expect(mockedGetPermission).toHaveBeenCalledTimes(1);
  });
});
