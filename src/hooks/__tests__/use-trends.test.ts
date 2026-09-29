/**
 * `useTrends` — the Trends screen's data hook.
 *
 * `useReadingStore`, `useSensorFeed` and `useSettings` are mocked directly rather than rendered
 * through their real providers: the hook only reads `store`/`backend`, `lastPolledAt`, and
 * `settings.sensorSource` from them, and mocking gives this suite independent control over
 * `backend` (real devices only ever report `'memory'` when SQLite failed to open — mocking lets
 * the `'unavailable'` rule be tested without faking that failure). The store itself is a real
 * `MemoryReadingStore` so `readSince` behaves exactly as the persisted store contract promises
 * (`src/store/__tests__/store-contract.ts`).
 *
 * Five things matter:
 * 1. `loading` while the first read is in flight, `ready` once it resolves with data.
 * 2. `empty` when the store has nothing plausible in range.
 * 3. `unavailable` fires from `backend`/`sensorSource` alone — the "memory backend + Health
 *    Connect selected" rule — independent of whether there happens to be data.
 * 4. A `lastPolledAt` change (a completed poll) triggers a re-read.
 * 5. A resolved read after unmount must not call `setState`.
 */

import { act, renderHook } from '@testing-library/react-native';

import { DEFAULT_SETTINGS } from '@/settings/store';
import { useSensorFeed } from '@/sensors/provider';
import { useSettings } from '@/settings/provider';
import { useReadingStore } from '@/store/provider';
import { MemoryReadingStore } from '@/store/memory';
import type { SensorFeed } from '@/sensors/types';
import type { SensorReading } from '@/risk';
import type { SettingsStore } from '@/settings/provider';
import type { ReadingStoreContextValue } from '@/store/provider';

import { useTrends } from '@/hooks/use-trends';

jest.mock('@/sensors/provider', () => ({ useSensorFeed: jest.fn() }));
jest.mock('@/settings/provider', () => ({ useSettings: jest.fn() }));
jest.mock('@/store/provider', () => ({ useReadingStore: jest.fn() }));

const mockedFeed = jest.mocked(useSensorFeed);
const mockedSettings = jest.mocked(useSettings);
const mockedStore = jest.mocked(useReadingStore);

const NOW = 1_766_000_000_000;
const HOUR = 60 * 60 * 1000;

function feed(overrides: Partial<SensorFeed> = {}): SensorFeed {
  return {
    readings: [],
    status: 'idle',
    failure: null,
    storeFailure: null,
    lastPolledAt: null,
    requestAccess: jest.fn(),
    refresh: jest.fn(),
    ...overrides,
  };
}

function settingsStore(overrides: Partial<SettingsStore['settings']> = {}): SettingsStore {
  return {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
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
  };
}

function storeContext(
  store: MemoryReadingStore,
  backend: ReadingStoreContextValue['backend'] = 'memory',
  ready = true,
): ReadingStoreContextValue {
  return { store, backend, ready };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockedFeed.mockReturnValue(feed());
  mockedSettings.mockReturnValue(settingsStore());
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useTrends', () => {
  it('starts loading, then reports ready with an aggregated series once the read resolves', async () => {
    const store = new MemoryReadingStore();
    await store.append([{ source: 'health_connect', timestamp: NOW - HOUR, hr: 88 }]);
    // Freeze `readSince` mid-flight so the transient `loading` render is observable — with the
    // real (fast) implementation, awaiting `renderHook` below already drains the microtask that
    // resolves it, and the hook would appear to skip straight to `ready`.
    let resolveRead: ((readings: SensorReading[]) => void) | undefined;
    jest
      .spyOn(store, 'readSince')
      .mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    mockedStore.mockReturnValue(storeContext(store));

    const { result } = await renderHook(() => useTrends('24h'));
    expect(result.current.status).toBe('loading');
    expect(result.current.series).toEqual([]);

    await act(async () => {
      resolveRead?.([{ source: 'health_connect', timestamp: NOW - HOUR, hr: 88 }]);
      await jest.runOnlyPendingTimersAsync();
    });

    expect(result.current.status).toBe('ready');
    const hrSeries = result.current.series.find((s) => s.field === 'hr');
    expect(hrSeries).toBeDefined();
    expect(hrSeries!.current).toBe(88);
  });

  it('reports empty when the store has nothing plausible in range', async () => {
    const store = new MemoryReadingStore();
    mockedStore.mockReturnValue(storeContext(store));

    const { result } = await renderHook(() => useTrends('24h'));

    expect(result.current.status).toBe('empty');
    expect(result.current.series).toEqual([]);
  });

  it('reports unavailable when the backend is memory and the source is Health Connect, regardless of data', async () => {
    const store = new MemoryReadingStore();
    await store.append([{ source: 'health_connect', timestamp: NOW - HOUR, hr: 88 }]);
    mockedStore.mockReturnValue(storeContext(store, 'memory'));
    mockedSettings.mockReturnValue(settingsStore({ sensorSource: 'health_connect' }));

    const { result } = await renderHook(() => useTrends('24h'));

    expect(result.current.status).toBe('unavailable');
  });

  it('is not unavailable on a memory backend when the source is not Health Connect', async () => {
    const store = new MemoryReadingStore();
    await store.append([{ source: 'health_connect', timestamp: NOW - HOUR, hr: 88 }]);
    mockedStore.mockReturnValue(storeContext(store, 'memory'));
    mockedSettings.mockReturnValue(settingsStore({ sensorSource: 'ble_esp32' }));

    const { result } = await renderHook(() => useTrends('24h'));

    expect(result.current.status).toBe('ready');
  });

  it('is not unavailable when the backend is sqlite, even with Health Connect selected', async () => {
    const store = new MemoryReadingStore();
    mockedStore.mockReturnValue(storeContext(store, 'sqlite'));
    mockedSettings.mockReturnValue(settingsStore({ sensorSource: 'health_connect' }));

    const { result } = await renderHook(() => useTrends('24h'));

    expect(result.current.status).toBe('empty');
  });

  it('reports loading, not unavailable, while the store is still opening (ready: false)', async () => {
    // `ReadingStoreProvider` serves a `MemoryReadingStore` placeholder — `backend: 'memory'` —
    // for the whole SQLite-open window, before `ready` flips. With Health Connect selected, that
    // placeholder must not be read as "SQLite failed" and flash the unavailable notice on every
    // cold start.
    const store = new MemoryReadingStore();
    mockedStore.mockReturnValue(storeContext(store, 'memory', false));
    mockedSettings.mockReturnValue(settingsStore({ sensorSource: 'health_connect' }));

    const { result } = await renderHook(() => useTrends('24h'));

    expect(result.current.status).toBe('loading');
  });

  it('re-reads when lastPolledAt changes', async () => {
    const store = new MemoryReadingStore();
    const readSpy = jest.spyOn(store, 'readSince');
    mockedStore.mockReturnValue(storeContext(store));
    mockedFeed.mockReturnValue(feed({ lastPolledAt: null }));

    const { result, rerender } = await renderHook(() => useTrends('24h'));
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('empty');

    // A poll landed: new data, and the feed's lastPolledAt moves.
    await store.append([{ source: 'health_connect', timestamp: NOW, spo2: 96 }]);
    mockedFeed.mockReturnValue(feed({ lastPolledAt: NOW }));
    await rerender({});

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
    expect(result.current.series.find((s) => s.field === 'spo2')?.current).toBe(96);
  });

  it('re-reads with a wider window and more buckets on a range change', async () => {
    const store = new MemoryReadingStore();
    const readSpy = jest.spyOn(store, 'readSince');
    mockedStore.mockReturnValue(storeContext(store));

    const { rerender } = await renderHook(({ range }: { range: '24h' | '7d' }) => useTrends(range), {
      initialProps: { range: '24h' },
    });
    expect(readSpy).toHaveBeenLastCalledWith(NOW - 24 * HOUR, NOW);

    await rerender({ range: '7d' });
    expect(readSpy).toHaveBeenLastCalledWith(NOW - 7 * 24 * HOUR, NOW);
  });

  it('does not update state after unmount', async () => {
    const store = new MemoryReadingStore();
    let resolveRead: (() => void) | undefined;
    jest.spyOn(store, 'readSince').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = () => resolve([]);
        }),
    );
    mockedStore.mockReturnValue(storeContext(store));

    const { unmount } = await renderHook(() => useTrends('24h'));
    await unmount();

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      resolveRead?.();
      await jest.runOnlyPendingTimersAsync();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
