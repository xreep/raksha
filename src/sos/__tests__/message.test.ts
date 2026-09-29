/**
 * SOS message composition tests.
 *
 * Two properties matter more than the exact wording:
 *
 * 1. **Every output stays GSM-7.** A single character outside that alphabet drops the SMS
 *    segment from 160 characters to 70, silently doubling the cost and the number of segments
 *    that can be lost or reordered on the degraded network PRD §8 says this must survive. The
 *    rest of the app writes `SpO₂` and `36.8 °C`, so this is a rule one careless copy-paste
 *    away from breaking — and nothing would visibly fail. Hence {@link isGsm7Safe} is asserted
 *    on *every* branch, not just the happy path.
 * 2. **A missing location never removes the alert.** The message degrades to a line saying so,
 *    because a contact who is told to call is still helped.
 */

import type { RuleId } from '@/risk';
import {
  composeSosMessage,
  describeCriticalRule,
  estimateSmsSegments,
  isGsm7Safe,
} from '@/sos/message';
import type { SosContext } from '@/sos/types';

/** 2026-08-23 14:32 local. Fixed so the timestamp line is exact. */
const NOW = new Date(2026, 7, 23, 14, 32, 0).getTime();

function context(overrides: Partial<SosContext> = {}): SosContext {
  return {
    criticalRules: ['respiratory.spo2.critical'],
    level: 'red',
    vitals: { hr: 132, spo2: 84, skinTempC: 37.24 },
    heatIndexC: 44.06,
    location: {
      ok: true,
      location: {
        latitude: 13.0827,
        longitude: 80.2707,
        accuracyM: 11.6,
        timestamp: NOW,
      },
    },
    userName: 'Asha',
    now: NOW,
    manual: false,
    ...overrides,
  };
}

describe('composeSosMessage', () => {
  it('leads with who needs help and why', () => {
    const message = composeSosMessage(context());

    // Actionable content first: a concatenated SMS can arrive truncated or out of order, so
    // the identity and the reason must be in the first segment.
    expect(message.split('\n')[0]).toBe('RAKSHA EMERGENCY - Asha needs help.');
    expect(message).toContain('Reason: Blood oxygen critically low.');
  });

  it('says "Someone" when no name is set rather than leaving a gap', () => {
    expect(composeSosMessage(context({ userName: '' }))).toContain('Someone needs help');
    expect(composeSosMessage(context({ userName: '   ' }))).toContain('Someone needs help');
    expect(composeSosMessage(context({ userName: undefined }))).toContain('Someone needs help');
  });

  it('reports vitals in ASCII, not the UI’s typography', () => {
    const message = composeSosMessage(context());

    expect(message).toContain('Vitals: HR 132 bpm, SpO2 84%, skin 37.2C');
    // The subscript and degree sign are what would silently halve the segment budget.
    expect(message).not.toContain('SpO₂');
    expect(message).not.toContain('°');
  });

  it('omits vitals the reading did not carry instead of printing placeholders', () => {
    const message = composeSosMessage(context({ vitals: { spo2: 84 } }));

    expect(message).toContain('Vitals: SpO2 84%');
    expect(message).not.toContain('HR');
    expect(message).not.toContain('skin');
  });

  it('drops the vitals line entirely when nothing was measured', () => {
    const message = composeSosMessage(context({ vitals: {} }));

    expect(message).not.toContain('Vitals:');
    // But the alert still goes, with the reason and the location.
    expect(message).toContain('Reason:');
    expect(message).toContain('Location:');
  });

  it('ignores non-finite vitals rather than printing NaN', () => {
    const message = composeSosMessage(
      context({ vitals: { hr: Number.NaN, spo2: Number.POSITIVE_INFINITY, skinTempC: 37 } }),
    );

    expect(message).toContain('Vitals: skin 37.0C');
    expect(message).not.toContain('NaN');
    expect(message).not.toContain('Infinity');
  });

  it('includes coordinates at six decimals with a map link and the accuracy radius', () => {
    const message = composeSosMessage(context());

    expect(message).toContain('Location: 13.082700, 80.270700 (+/-12m)');
    expect(message).toContain('Map: https://maps.google.com/?q=13.082700,80.270700');
  });

  it('says the accuracy is unknown rather than implying a doorstep', () => {
    const message = composeSosMessage(
      context({
        location: {
          ok: true,
          location: { latitude: 13.0827, longitude: 80.2707, accuracyM: null, timestamp: NOW },
        },
      }),
    );

    expect(message).toContain('(accuracy unknown)');
  });

  it('still sends when the fix failed, naming the reason', () => {
    for (const [reason, text] of [
      ['permission_denied', 'location permission off'],
      ['services_disabled', 'device location turned off'],
      ['timeout', 'no GPS fix in time'],
      ['unavailable', 'location unavailable'],
    ] as const) {
      const message = composeSosMessage(context({ location: { ok: false, reason } }));

      expect(message).toContain(`Location: unavailable (${text})`);
      // The alert is intact — this is the whole reason a failed fix must not abort a dispatch.
      expect(message).toContain('RAKSHA EMERGENCY');
      expect(message).toContain('Reason: Blood oxygen critically low.');
      expect(isGsm7Safe(message)).toBe(true);
    }
  });

  it('distinguishes "not requested" from "unavailable"', () => {
    // Null means the dispatch never asked (a test path, or a future manual-only mode). Saying
    // "unavailable" there would blame the device for something the app chose.
    expect(composeSosMessage(context({ location: null }))).toContain('Location: not requested');
  });

  it('names the manual press instead of inventing a clinical reason', () => {
    const message = composeSosMessage(context({ manual: true, criticalRules: [] }));

    expect(message).toContain('Reason: Emergency button pressed.');
  });

  it('joins multiple causes and deduplicates them', () => {
    const message = composeSosMessage(
      context({
        criticalRules: [
          'respiratory.spo2.critical',
          'fall.impactThenStillness',
          'fall.impactThenStillness',
        ],
      }),
    );

    expect(message).toContain(
      'Reason: Blood oxygen critically low; Possible fall, no movement since.',
    );
  });

  it('falls back to a true statement for a rule with no cause text', () => {
    // A rule added to the engine without a line in `RULE_CAUSE` must not produce
    // "Reason: undefined" in an emergency message.
    const message = composeSosMessage(context({ criticalRules: ['heat.index.danger'] }));

    expect(message).toContain('Reason: Critical health risk detected.');
  });

  it('includes the heat index only when there is one', () => {
    expect(composeSosMessage(context())).toContain('Heat index: 44.1C');
    expect(composeSosMessage(context({ heatIndexC: null }))).not.toContain('Heat index');
    expect(composeSosMessage(context({ heatIndexC: undefined }))).not.toContain('Heat index');
    expect(composeSosMessage(context({ heatIndexC: Number.NaN }))).not.toContain('Heat index');
  });

  it('stamps a local timestamp built without toLocaleString', () => {
    // `toLocaleString` can emit a narrow no-break space before an AM/PM marker — a character
    // outside GSM-7 that would halve the segment budget with nothing on screen to show it.
    expect(composeSosMessage(context())).toContain('Time: 2026-08-23 14:32');
  });

  it('says the time is unknown rather than printing Invalid Date', () => {
    expect(composeSosMessage(context({ now: Number.NaN }))).toContain('Time: time unknown');
  });

  it('closes with provenance so a recipient knows it was automatic', () => {
    expect(composeSosMessage(context()).split('\n').at(-1)).toBe(
      'Sent automatically by Raksha.',
    );
  });

  it('is GSM-7 safe on every branch, including with a non-ASCII user name', () => {
    const cases: SosContext[] = [
      context(),
      context({ manual: true, criticalRules: [] }),
      context({ vitals: {}, heatIndexC: null, location: null }),
      context({ location: { ok: false, reason: 'timeout' } }),
      // A user who typed their name in Devanagari. This one *is* expected to break GSM-7 —
      // the guarantee is about the parts this module composes, and a user-supplied name is
      // not one of them. Asserted explicitly so the boundary is documented rather than
      // discovered.
    ];

    for (const input of cases) {
      expect(isGsm7Safe(composeSosMessage(input))).toBe(true);
    }

    expect(isGsm7Safe(composeSosMessage(context({ userName: 'आशा' })))).toBe(false);
  });
});

describe('isGsm7Safe', () => {
  it('accepts the parts of the alphabet a naive ASCII check would reject', () => {
    // The two alphabets overlap without either containing the other, which is why this is a
    // set membership test and not a printable-ASCII range check. The omega below is U+03A9,
    // the Greek letter GSM-7 actually contains — not U+2126, the visually identical ohm sign,
    // which it does not.
    expect(isGsm7Safe('£100 §5 Äpfel à la Ω')).toBe(true);
    expect(isGsm7Safe('\n\r')).toBe(true);
    expect(isGsm7Safe('{}[]~|^€')).toBe(true); // extension table
  });

  it('rejects characters GSM-7 lacks, including ones ASCII has', () => {
    expect(isGsm7Safe('`')).toBe(false); // backtick is ASCII but not GSM-7
    expect(isGsm7Safe('\\')).toBe(false);
    expect(isGsm7Safe('SpO₂')).toBe(false);
    expect(isGsm7Safe('36.8 °C')).toBe(false);
    expect(isGsm7Safe('a · b')).toBe(false);
    expect(isGsm7Safe('±5')).toBe(false);
    expect(isGsm7Safe(' ')).toBe(false); // narrow no-break space
  });

  it('treats the empty string as safe', () => {
    expect(isGsm7Safe('')).toBe(true);
  });
});

describe('estimateSmsSegments', () => {
  it('fits a full alert into a small number of segments', () => {
    const message = composeSosMessage(context());

    // Not pinned to an exact count — the wording will change. Pinned to the property that
    // matters: an alert stays cheap and stays reassemblable.
    expect(message.length).toBeGreaterThan(160);
    expect(estimateSmsSegments(message)).toBeLessThanOrEqual(3);
  });

  it('uses 160 septets for one segment and 153 once concatenated', () => {
    expect(estimateSmsSegments('a'.repeat(160))).toBe(1);
    expect(estimateSmsSegments('a'.repeat(161))).toBe(2);
    expect(estimateSmsSegments('a'.repeat(306))).toBe(2); // 2 × 153
    expect(estimateSmsSegments('a'.repeat(307))).toBe(3);
  });

  it('charges extension-table characters the two septets they really cost', () => {
    // 80 euro signs are 160 septets — exactly one segment. Counting characters instead of
    // septets would report one segment for 160 of them, which is two in reality.
    expect(estimateSmsSegments('€'.repeat(80))).toBe(1);
    expect(estimateSmsSegments('€'.repeat(81))).toBe(2);
  });

  it('reports zero for an empty message', () => {
    expect(estimateSmsSegments('')).toBe(0);
  });
});

describe('describeCriticalRule', () => {
  it('returns the same wording the message body uses', () => {
    // Shared deliberately: the reason shown during the cancel window has to be the reason the
    // contacts receive, or the user cancels based on something different from what was sent.
    const rule: RuleId = 'fall.impactThenStillness';
    expect(composeSosMessage(context({ criticalRules: [rule] }))).toContain(
      describeCriticalRule(rule),
    );
  });

  it('degrades to a true statement for an unmapped rule', () => {
    expect(describeCriticalRule('cardiovascular.hr.bradycardia')).toBe(
      'Critical health risk detected',
    );
  });
});
