/**
 * Persisted user settings (PRD §7.2.4 Settings, §7.2.6 privacy).
 *
 * ## Why these have to be persisted rather than held in `useState`
 * The Settings screen used to keep its toggles in component state and read its contacts from
 * a hardcoded array. That is fine for a shell, and wrong the moment SOS is real: the consent
 * gate PRD §7.2.6 describes ("no raw health data leaves device without explicit user opt-in")
 * has to survive a remount to mean anything, and an emergency contact list that resets when
 * the process restarts cannot be relied on in an emergency.
 *
 * ## Validate on read, same as the environment cache
 * The stored blob is JSON written by a *previous build*. `src/environment/cache.ts` documents
 * the failure this prevents — a field rename turning into `undefined.toFixed()` for every
 * existing install while every test passes on the new schema — and the reasoning is identical
 * here, with a sharper edge: a malformed contact list that deserialises into
 * `[{ phone: undefined }]` would make the SOS path silently unable to reach anyone.
 *
 * So the key carries a schema version, every field is checked, and anything unreadable falls
 * back to {@link DEFAULT_SETTINGS} rather than being partially trusted.
 *
 * ## There are deliberately no seeded demo contacts
 * The previous `EMERGENCY_CONTACTS` constant held two realistic-looking Indian numbers. Now
 * that a real send path exists, shipping those as defaults would mean a demo tap texts a
 * stranger — `+91 98765 43210` normalises to a structurally valid E.164 number, so no
 * validation layer would stop it. `health-data.ts` already states this principle for the
 * weather constant it deleted ("keeping a plausible-looking fallback beside a live feed is how
 * a demo value ends up on screen with nothing saying so"); the same applies with real
 * consequences. The list starts empty and the screen says why.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DataSharingPref, SensorSourceOption } from '@/constants/health-data';
import { DATA_SHARING_PREFS, DEFAULT_SENSOR_SOURCE, SENSOR_SOURCES } from '@/constants/health-data';
import { DEFAULT_PROFILE, parseProfile, type UserProfile } from '@/settings/profile';
import { normalizePhone } from '@/sos/phone';
import { normalizeTelegramChatId } from '@/sos/telegram-link';
import type { EmergencyContact } from '@/sos/types';

/** Bump the suffix on any breaking shape change. Old entries then miss rather than
 *  deserialise into a half-populated object. */
export const SETTINGS_KEY = 'phc.settings.v1';

export type SharingPrefs = Readonly<Record<DataSharingPref['key'], boolean>>;

/** M3 alerts (workstream G): local notifications on a risk-level change. A record rather than a
 *  bare boolean so a later per-category mute or quiet-hours setting has somewhere to live
 *  without another top-level `PersistedSettings` field and another schema-version bump. */
export type AlertPrefs = {
  readonly enabled: boolean;
};

export type PersistedSettings = {
  /** Empty until the user adds someone. See the module note on why nothing is seeded. */
  readonly contacts: readonly EmergencyContact[];
  /** Named in the SOS message so a contact knows who needs help. Blank is allowed. */
  readonly userName: string;
  readonly sharing: SharingPrefs;
  readonly sensorSource: SensorSourceOption['key'];
  /**
   * Captured, not applied — see `src/settings/profile.ts`'s module header and
   * ADR-005. Nothing downstream of this field currently changes behaviour based on it.
   */
  readonly profile: UserProfile;
  readonly alerts: AlertPrefs;
  /**
   * Demo mode (workstream I1): puts the Dashboard's simulation controls on screen in *release*
   * builds, with a permanent "Demo mode" label beside the header while it is on.
   *
   * A persisted setting rather than a `__DEV__` check, because the thing being demonstrated is
   * the shipped APK — a control that only exists in a development bundle cannot be shown to
   * anyone holding the phone. It is off by default and fails closed on read (see
   * {@link parseSettings}): the controls shape the engine's *input*, so a blob we cannot read
   * must never resolve into "show simulated readings".
   *
   * Nothing this flag enables is ever written to the reading store — see
   * `docs/features/demo-mode.md`.
   */
  readonly demoMode: boolean;
};

const DEFAULT_SHARING: SharingPrefs = Object.freeze(
  Object.fromEntries(DATA_SHARING_PREFS.map((pref) => [pref.key, pref.defaultOn])),
) as SharingPrefs;

/** On by default: a red card nobody is looking at is not an early warning, and a feature that
 *  ships silent-until-opted-in mostly ships unused. Unlike `sharing`, nothing here sends data
 *  anywhere — see `docs/features/notifications.md` — so the "off unless earned" reasoning the
 *  module header gives for sharing prefs does not apply. */
const DEFAULT_ALERTS: AlertPrefs = Object.freeze({ enabled: true });

export const DEFAULT_SETTINGS: PersistedSettings = Object.freeze({
  contacts: [],
  userName: '',
  sharing: DEFAULT_SHARING,
  sensorSource: DEFAULT_SENSOR_SOURCE,
  profile: DEFAULT_PROFILE,
  alerts: DEFAULT_ALERTS,
  demoMode: false,
});

const SHARING_KEYS = new Set<string>(DATA_SHARING_PREFS.map((pref) => pref.key));
const SOURCE_KEYS = new Set<string>(SENSOR_SOURCES.map((option) => option.key));

/**
 * Accept a stored contact only if it can still reach someone.
 *
 * The phone number is re-normalized on read rather than trusted. A build that stored numbers
 * in a looser format, or a hand-edited storage blob, would otherwise put a string the relay
 * rejects into the send path — and the first time anyone finds out is during an emergency.
 * Anything unnormalizable is dropped, which is visible in the UI as a missing contact rather
 * than invisible as a failing send.
 *
 * The Telegram chat id gets the opposite treatment: a malformed one drops the *field*, never
 * the contact. It is optional and the SMS lane still reaches the person, so losing a whole
 * emergency contact over a stray character in it would be the worse failure.
 */
function parseContact(value: unknown): EmergencyContact | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, name, relation, phone } = record;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || typeof phone !== 'string') return null;

  const normalized = normalizePhone(phone);
  if (normalized === null) return null;

  return withTelegramChatId(
    {
      id,
      name,
      relation: typeof relation === 'string' ? relation : '',
      phone: normalized,
    },
    record.telegramChatId,
  );
}

/** Attach a validated chat id, or return the contact without the key at all — never with
 *  `telegramChatId: undefined`, which would make an unlinked contact fail deep equality
 *  against one that was never linked. */
function withTelegramChatId(contact: EmergencyContact, raw: unknown): EmergencyContact {
  const telegramChatId = normalizeTelegramChatId(raw);
  const bare: EmergencyContact = {
    id: contact.id,
    name: contact.name,
    relation: contact.relation,
    phone: contact.phone,
  };
  return telegramChatId === undefined ? bare : { ...bare, telegramChatId };
}

function parseSharing(value: unknown): SharingPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_SHARING;
  const record = value as Record<string, unknown>;

  // Built from the *known* key list rather than from the stored object's keys, so a pref
  // removed from the app cannot linger and a pref added to the app gets its documented
  // default instead of `undefined`.
  const merged: Record<string, boolean> = { ...DEFAULT_SHARING };
  for (const key of Object.keys(record)) {
    if (SHARING_KEYS.has(key) && typeof record[key] === 'boolean') {
      merged[key] = record[key] as boolean;
    }
  }
  return merged as SharingPrefs;
}

/** Absent (a pre-M3 blob), the wrong shape, or a non-boolean `enabled` all fall back to the
 *  documented default (`true`) rather than reading as an explicit opt-out — see
 *  {@link DEFAULT_ALERTS}. Only a *real* stored `false` turns notifications off. */
function parseAlerts(value: unknown): AlertPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_ALERTS;
  const record = value as Record<string, unknown>;
  return typeof record.enabled === 'boolean' ? { enabled: record.enabled } : DEFAULT_ALERTS;
}

function parseSettings(value: unknown): PersistedSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const record = value as Record<string, unknown>;

  const contacts = Array.isArray(record.contacts)
    ? record.contacts.map(parseContact).filter((c): c is EmergencyContact => c !== null)
    : [];

  const source = record.sensorSource;

  return {
    contacts,
    userName: typeof record.userName === 'string' ? record.userName : '',
    sharing: parseSharing(record.sharing),
    sensorSource:
      typeof source === 'string' && SOURCE_KEYS.has(source)
        ? (source as SensorSourceOption['key'])
        : DEFAULT_SENSOR_SOURCE,
    // Missing on any blob written before this field existed; `parseProfile` already treats
    // that the same as an explicit `undefined`, so no extra branch is needed here.
    profile: parseProfile(record.profile),
    alerts: parseAlerts(record.alerts),
    // Fails *closed*, which is the opposite of `parseAlerts` and deliberate. A missing field is
    // an old blob; a `'true'` or a `1` is a blob we do not understand. Neither is a user asking
    // for simulated readings on their Dashboard, so only a literal boolean `true` turns it on.
    demoMode: record.demoMode === true,
  };
}

/**
 * Load settings, or the documented defaults.
 *
 * Never rejects. Storage being unavailable must not stop the app from starting, and defaults
 * are a correct state to start in — the only thing lost is the user's previous choices, which
 * the Settings screen shows them plainly.
 */
export async function readSettings(): Promise<PersistedSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist settings. Returns whether the write landed, so the UI can warn rather than
 *  silently forget an emergency contact the user believes is saved. */
export async function writeSettings(settings: PersistedSettings): Promise<boolean> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Test/reset helper. */
export async function clearSettings(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Nothing actionable.
  }
}

// ---------------------------------------------------------------------------
// Pure reducers. Kept separate from the I/O above so the list semantics are
// unit-testable without storage, and so the provider stays a thin wrapper.
// ---------------------------------------------------------------------------

/**
 * Add or replace a contact.
 *
 * Replaces by `id`, so editing is the same operation as adding and the caller does not need
 * two code paths. Rejects an unnormalizable number by returning the settings unchanged —
 * silently storing it would put a number the relay cannot use in the send path.
 */
export function upsertContact(
  settings: PersistedSettings,
  contact: EmergencyContact,
): PersistedSettings {
  const phone = normalizePhone(contact.phone);
  if (phone === null) return settings;

  const normalized = withTelegramChatId({ ...contact, phone }, contact.telegramChatId);
  const index = settings.contacts.findIndex((existing) => existing.id === contact.id);

  const contacts =
    index === -1
      ? [...settings.contacts, normalized]
      : settings.contacts.map((existing, i) => (i === index ? normalized : existing));

  return { ...settings, contacts };
}

export function removeContact(settings: PersistedSettings, id: string): PersistedSettings {
  return { ...settings, contacts: settings.contacts.filter((contact) => contact.id !== id) };
}

export function setSharingPref(
  settings: PersistedSettings,
  key: DataSharingPref['key'],
  value: boolean,
): PersistedSettings {
  return { ...settings, sharing: { ...settings.sharing, [key]: value } };
}

/**
 * Patch one or more profile fields, leaving the rest of the profile — and the rest of
 * `settings` — untouched. A patch rather than a full replacement so the Settings screen's
 * individual pickers/toggles can each call this with just the field they own.
 */
export function setProfile(
  settings: PersistedSettings,
  patch: Partial<UserProfile>,
): PersistedSettings {
  return { ...settings, profile: { ...settings.profile, ...patch } };
}

/**
 * Whether SOS may send at all.
 *
 * The one consent gate that governs an outbound path carrying personal data (PRD §7.2.6).
 * Read through a function so every call site expresses the same intent and none of them
 * reaches into `sharing` directly and forgets which key means what.
 */
export function isSosEnabled(settings: PersistedSettings): boolean {
  return settings.sharing.sos === true;
}

/**
 * Whether the Community View may show any figures (PRD §4, ASHA persona).
 *
 * Named for the same reason as {@link isSosEnabled} — the screen asks a question about intent,
 * not about which string happens to key the pref.
 *
 * Off by default, and `anon_aggregate` is deliberately reused rather than joined by a second
 * key: the pref already reads "share coarse, de-identified risk trends with local responders",
 * which is precisely what this screen demonstrates. A separate toggle would let a user consent
 * to community aggregation in one place and decline it in another, and there would be no
 * defensible answer as to which one won.
 */
export function isCommunityInsightsEnabled(settings: PersistedSettings): boolean {
  return settings.sharing.anon_aggregate === true;
}
