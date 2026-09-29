/**
 * One settings store for the whole app.
 *
 * Same reasoning as `src/environment/provider.tsx`: two screens read this data — Settings
 * edits it, and the Dashboard's SOS hook reads the contact list and the consent flag — and
 * Expo Router keeps both mounted at once. Two independent `useSettings()` calls would each
 * hold their own copy, so adding a contact in Settings would leave the Dashboard's SOS path
 * still believing there were none. Hoisting to one provider makes that disagreement
 * structurally impossible.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { DataSharingPref, SensorSourceOption } from '@/constants/health-data';
import type { UserProfile } from '@/settings/profile';
import type { EmergencyContact } from '@/sos/types';

import {
  DEFAULT_SETTINGS,
  readSettings,
  removeContact as removeContactIn,
  setProfile as setProfileIn,
  setSharingPref,
  upsertContact,
  writeSettings,
  type PersistedSettings,
} from './store';

export type SettingsStore = {
  readonly settings: PersistedSettings;
  /**
   * False until the first read from storage resolves.
   *
   * Load-bearing for SOS: before this flips, `settings.contacts` is the empty default rather
   * than "the user has no contacts", and the two must not be confused. The SOS hook refuses
   * to arm while this is false, so a critical reading in the first few hundred milliseconds
   * after launch cannot dispatch an alert to an empty list and report "no contacts" when the
   * user in fact has three.
   */
  readonly loaded: boolean;
  /** True when the last persist failed, so Settings can warn instead of implying saved. */
  readonly writeFailed: boolean;
  readonly addContact: (contact: EmergencyContact) => void;
  readonly removeContact: (id: string) => void;
  readonly setUserName: (name: string) => void;
  readonly setSharing: (key: DataSharingPref['key'], value: boolean) => void;
  readonly setSensorSource: (source: SensorSourceOption['key']) => void;
  /** Patch one or more "About you" fields. See `src/settings/profile.ts` — captured, not
   *  yet applied to risk output. */
  readonly setProfile: (patch: Partial<UserProfile>) => void;
  /** M3 alerts: the Settings "Alert notifications" toggle. */
  readonly setAlertsEnabled: (enabled: boolean) => void;
  /** I1 demo mode: the Settings "Demo mode" toggle. See `PersistedSettings.demoMode`. */
  readonly setDemoMode: (enabled: boolean) => void;
};

const SettingsContext = createContext<SettingsStore | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PersistedSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);

  // Guards the persist effect below. A ref rather than the `loaded` state because the effect
  // must not re-run when it flips — it reads the value at the moment settings change.
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void readSettings().then((stored) => {
      if (cancelled) return;
      setSettings(stored);
      loadedRef.current = true;
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on every change *after* the initial load. Without the guard, the default value
  // this hook starts with would be written over the stored settings on first mount, wiping
  // the user's contacts on every launch — a silent data loss that no test of the reducers
  // would catch.
  useEffect(() => {
    if (!loadedRef.current) return;
    void writeSettings(settings).then((ok) => setWriteFailed(!ok));
  }, [settings]);

  const addContact = useCallback((contact: EmergencyContact) => {
    setSettings((prev) => upsertContact(prev, contact));
  }, []);

  const removeContact = useCallback((id: string) => {
    setSettings((prev) => removeContactIn(prev, id));
  }, []);

  const setUserName = useCallback((name: string) => {
    setSettings((prev) => ({ ...prev, userName: name }));
  }, []);

  const setSharing = useCallback((key: DataSharingPref['key'], value: boolean) => {
    setSettings((prev) => setSharingPref(prev, key, value));
  }, []);

  const setSensorSource = useCallback((source: SensorSourceOption['key']) => {
    setSettings((prev) => ({ ...prev, sensorSource: source }));
  }, []);

  const setProfile = useCallback((patch: Partial<UserProfile>) => {
    setSettings((prev) => setProfileIn(prev, patch));
  }, []);

  const setAlertsEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, alerts: { ...prev.alerts, enabled } }));
  }, []);

  const setDemoMode = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, demoMode: enabled }));
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        loaded,
        writeFailed,
        addContact,
        removeContact,
        setUserName,
        setSharing,
        setSensorSource,
        setProfile,
        setAlertsEnabled,
        setDemoMode,
      }}>
      {children}
    </SettingsContext.Provider>
  );
}

/**
 * The shared settings store.
 *
 * Throws without a provider, for the reason `useEnvironmentFeed` does: an inert default would
 * render a Settings screen whose toggles do nothing and an SOS path that believes it has no
 * contacts, with nothing anywhere reporting a fault.
 */
export function useSettings(): SettingsStore {
  const store = useContext(SettingsContext);
  if (store === null) {
    throw new Error('useSettings must be used inside a <SettingsProvider>.');
  }
  return store;
}
