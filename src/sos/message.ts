/**
 * SOS message composition (PRD §7.2.5: "risk summary + GPS coordinates").
 *
 * Pure: every input arrives in the {@link SosContext}, including `now`. No clock, no I/O.
 *
 * ## Why the output is ASCII-only, deliberately
 * The rest of the app writes `SpO₂`, `36.8 °C`, and `·` separators, and this file
 * pointedly does not. An SMS encoded in GSM-7 carries 160 characters per segment; a single
 * character outside that alphabet forces the whole message to UCS-2, which drops the segment
 * to **70** characters. `SpO₂` alone would therefore roughly double the segment count of
 * every emergency alert — more cost on the Twilio path, and more segments to lose or reorder
 * on a degraded network in exactly the conditions PRD §8 says this has to survive. So the
 * subscript, the degree sign, the middle dot, and `±` are all spelled out in ASCII, and
 * {@link isGsm7Safe} guards it.
 *
 * The message also leads with the actionable part. A concatenated SMS can arrive out of
 * order or truncated, so who-and-what-and-where comes first and the provenance footer last.
 */

import type { RuleId } from '@/risk';

import type { SosContext, SosLocationFailure, SosLocationResult } from './types';

/**
 * Plain-language cause per critical rule.
 *
 * Keyed on {@link RuleId} rather than on guidance prose so the wording here cannot drift
 * from the engine, and written for a *recipient* — the contact reading this is not the
 * patient and does not know what "SpO2 critical" means, so each line says what is happening
 * to the person rather than which threshold was crossed.
 */
const RULE_CAUSE: Partial<Record<RuleId, string>> = {
  'respiratory.spo2.critical': 'Blood oxygen critically low',
  'fall.impactThenStillness': 'Possible fall, no movement since',
  'heat.stillness.critical': 'Extreme heat, no movement',
};

/** Why a fix is missing, in words a contact can act on. */
const LOCATION_FAILURE_TEXT: Record<SosLocationFailure, string> = {
  permission_denied: 'location permission off',
  services_disabled: 'device location turned off',
  timeout: 'no GPS fix in time',
  unavailable: 'location unavailable',
};

/** Coordinate decimals. Six is ~0.1 m — far finer than any consumer fix, and the
 *  convention every mapping tool expects, so no precision is lost in the handoff. */
const COORDINATE_DECIMALS = 6;

/**
 * The GSM-7 default alphabet.
 *
 * Enumerated as a `Set` rather than compiled into a regex character class on purpose: the
 * alphabet contains `-`, `[`, `]`, `^`, and `\` , every one of which changes meaning inside
 * `[...]`, and an escaping slip there fails in the *permissive* direction — the guard would
 * pass text that is not GSM-7 and silently halve the segment budget. Set membership has no
 * such trap.
 *
 * Not approximated by a printable-ASCII range either: the two alphabets overlap but neither
 * contains the other (GSM-7 has `£`, `§`, `Ä`; ASCII has backtick and `\`, which GSM-7 lacks).
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/**
 * The extension table. These encode as an escape septet *plus* the character, so each one
 * costs two of the 160 — which is why {@link estimateSmsSegments} weighs them separately.
 */
const GSM7_EXTENDED = '\f^{}[]~|€';

const GSM7_BASIC_SET = new Set([...GSM7_BASIC]);
const GSM7_EXTENDED_SET = new Set([...GSM7_EXTENDED]);

/**
 * Whether `text` survives GSM-7 encoding rather than forcing the whole message to UCS-2.
 *
 * Exported for the test that pins every branch of {@link composeSosMessage} — the guarantee
 * is worthless if only the happy path is checked.
 */
export function isGsm7Safe(text: string): boolean {
  for (const char of text) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENDED_SET.has(char)) return false;
  }
  return true;
}

/** Septets `text` occupies in GSM-7, counting extension-table characters as two. */
function gsm7Septets(text: string): number {
  let septets = 0;
  for (const char of text) septets += GSM7_EXTENDED_SET.has(char) ? 2 : 1;
  return septets;
}

/**
 * The same plain-language cause, for the on-screen alert.
 *
 * Shared with {@link composeSosMessage} rather than re-worded in the component, so the reason
 * the user reads during the cancel window is verbatim the reason their contacts receive. Two
 * separate copies of this wording would drift, and the countdown screen is precisely where a
 * user decides whether the alert is a false alarm — being shown a different reason than the one
 * that will be sent is how they cancel the wrong thing.
 */
export function describeCriticalRule(rule: RuleId): string {
  return RULE_CAUSE[rule] ?? 'Critical health risk detected';
}

/** Two-digit zero pad, for the timestamp. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `2026-08-23 14:32` in **device-local** time.
 *
 * Built by hand rather than with `toLocaleString`, which varies by locale and ICU build and
 * can emit a narrow no-break space between the time and an AM/PM marker — a character
 * outside GSM-7 that would silently halve the segment budget. Local rather than UTC because
 * the recipient is local to the person in trouble.
 */
function formatTimestamp(now: number): string {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The reason line: the worst rule that fired, or the manual press. */
function causeText(context: SosContext): string {
  if (context.manual) return 'Emergency button pressed';

  const causes = context.criticalRules
    .map((rule) => RULE_CAUSE[rule])
    .filter((cause): cause is string => cause !== undefined);

  if (causes.length === 0) {
    // Either no rules (shouldn't happen for a non-manual trigger) or a rule added to the
    // engine without a cause string here. Say something true rather than nothing.
    return 'Critical health risk detected';
  }
  // Deduplicated because two categories can report the same underlying rule — `fall.
  // impactThenStillness` is both a spec flag and a critical escalation.
  return [...new Set(causes)].join('; ');
}

/** `HR 132 bpm, SpO2 84%, skin 37.2C` — omitting whatever the reading did not carry. */
function vitalsText(context: SosContext): string | null {
  const parts: string[] = [];
  const { hr, spo2, skinTempC } = context.vitals;

  if (hr !== undefined && Number.isFinite(hr)) parts.push(`HR ${Math.round(hr)} bpm`);
  if (spo2 !== undefined && Number.isFinite(spo2)) parts.push(`SpO2 ${Math.round(spo2)}%`);
  if (skinTempC !== undefined && Number.isFinite(skinTempC)) {
    parts.push(`skin ${skinTempC.toFixed(1)}C`);
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The location block: coordinates, accuracy, and a map link.
 *
 * The accuracy figure is not decoration. A fix good to 12 m sends a responder to a doorstep;
 * one good to 3 km sends them to a suburb, and they need to know which they have before they
 * set out. Omitting it would let the same two-line format imply the former in both cases.
 */
function locationLines(result: SosLocationResult | null): string[] {
  if (result === null) {
    return ['Location: not requested'];
  }
  if (!result.ok) {
    return [`Location: unavailable (${LOCATION_FAILURE_TEXT[result.reason]})`];
  }

  const { latitude, longitude, accuracyM } = result.location;
  const lat = latitude.toFixed(COORDINATE_DECIMALS);
  const lon = longitude.toFixed(COORDINATE_DECIMALS);

  const accuracy =
    accuracyM !== null && Number.isFinite(accuracyM)
      ? ` (+/-${Math.round(accuracyM)}m)`
      : ' (accuracy unknown)';

  return [
    `Location: ${lat}, ${lon}${accuracy}`,
    // `geo:` would be more correct semantically but is not clickable in most SMS clients;
    // a plain https link opens in whatever map app the recipient already has.
    `Map: https://maps.google.com/?q=${lat},${lon}`,
  ];
}

/**
 * Compose the alert body sent to every contact.
 *
 * One message for all recipients rather than a per-contact variant: the content is identical
 * by nature, and personalising it would multiply the ways a bug could produce a *different*
 * emergency message for one contact than another.
 */
export function composeSosMessage(context: SosContext): string {
  const who = context.userName?.trim();
  const subject = who !== undefined && who.length > 0 ? `${who} needs help` : 'Someone needs help';

  const lines: string[] = [`RAKSHA EMERGENCY - ${subject}.`, `Reason: ${causeText(context)}.`];

  const vitals = vitalsText(context);
  if (vitals !== null) lines.push(`Vitals: ${vitals}`);

  const heat = context.heatIndexC;
  if (heat !== undefined && heat !== null && Number.isFinite(heat)) {
    lines.push(`Heat index: ${heat.toFixed(1)}C`);
  }

  lines.push(...locationLines(context.location));
  lines.push(`Time: ${formatTimestamp(context.now)}`);
  lines.push('Sent automatically by Raksha.');

  return lines.join('\n');
}

/**
 * Segments the message will occupy at GSM-7's 160/153 septets.
 *
 * Concatenated SMS spends 6 bytes per segment on the UDH that reassembles it, which is why
 * multi-segment messages get 153 septets rather than 160. Counts extension-table characters
 * as the two septets they actually cost. Surfaced so the Settings screen can show what an
 * alert costs and so a test can catch a wording change that doubles it.
 */
export function estimateSmsSegments(message: string): number {
  const septets = gsm7Septets(message);
  if (septets === 0) return 0;
  if (septets <= 160) return 1;
  return Math.ceil(septets / 153);
}
