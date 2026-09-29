/**
 * SOS state machine tests.
 *
 * The reducer is where the sequence's dangerous edges live, and they are dangerous in both
 * directions: a machine that under-fires leaves someone unattended, and one that over-fires
 * texts a family every sixty seconds until they mute the app — after which it may as well
 * under-fire. So the cases below are organised around the four ways this can go wrong:
 *
 * - the alert never fires (the boundary at exactly 30 s, and re-arming that restarts the window)
 * - the alert fires when the user said no (suppression)
 * - the alert repeats (cooldown, including on refusals)
 * - the alert is refused when a person deliberately asked for it (manual vs both guards)
 *
 * Purity is what makes this testable at all: `now` is an argument, so the 30-second boundary is
 * asserted at exactly `firesAt`, `firesAt - 1`, and `firesAt + 1` with no fake timers.
 */

import type { RuleId } from '@/risk';
import {
  countdownRemainingMs,
  countdownSeconds,
  DEFAULT_SOS_MACHINE_CONFIG,
  INITIAL_SOS_STATE,
  sosReducer,
  triggerSignature,
  type SosEvent,
  type SosMachineConfig,
  type SosMachineState,
} from '@/sos/machine';
import type { SosDispatchResult } from '@/sos/types';

const T0 = 1_766_000_000_000;

/** Short round numbers, so the arithmetic in each assertion is readable. The real values are
 *  asserted once, against the config, in the last block. */
const CONFIG: SosMachineConfig = { cancelWindowMs: 30_000, cooldownMs: 300_000 };

const CRITICAL: readonly RuleId[] = ['respiratory.spo2.critical'];

function assess(overrides: Partial<Extract<SosEvent, { type: 'assess' }>> = {}): SosEvent {
  return {
    type: 'assess',
    signature: triggerSignature(CRITICAL),
    criticalRules: CRITICAL,
    now: T0,
    hasContacts: true,
    consent: true,
    ...overrides,
  };
}

function manual(overrides: Partial<Extract<SosEvent, { type: 'manual' }>> = {}): SosEvent {
  return { type: 'manual', now: T0, hasContacts: true, consent: true, ...overrides };
}

function reduce(state: SosMachineState, ...events: readonly SosEvent[]): SosMachineState {
  return events.reduce((acc, event) => sosReducer(acc, event, CONFIG), state);
}

function result(overrides: Partial<SosDispatchResult> = {}): SosDispatchResult {
  return {
    attempts: [],
    relayDelivered: [],
    nativeSmsPending: false,
    failed: false,
    message: 'RAKSHA EMERGENCY',
    ...overrides,
  };
}

/** State with a live countdown, armed at `T0`. */
function armed(): SosMachineState {
  return reduce(INITIAL_SOS_STATE, assess());
}

describe('triggerSignature', () => {
  it('is null when nothing critical fired, which is the signal that clears suppression', () => {
    expect(triggerSignature([])).toBeNull();
  });

  it('is order-independent, so a reordered rule list is not a new emergency', () => {
    // `assessRisk` makes no ordering promise. Without the sort, a reordering between two
    // 60-second ticks would read as a fresh trigger and defeat suppression *and* cooldown —
    // the exact failure that re-texts a family who already cancelled.
    const a = triggerSignature(['respiratory.spo2.critical', 'fall.impactThenStillness']);
    const b = triggerSignature(['fall.impactThenStillness', 'respiratory.spo2.critical']);

    expect(a).toBe(b);
    expect(a).toBe('fall.impactThenStillness|respiratory.spo2.critical');
  });

  it('distinguishes different rule sets', () => {
    expect(triggerSignature(['respiratory.spo2.critical'])).not.toBe(
      triggerSignature(['respiratory.spo2.critical', 'fall.impactThenStillness']),
    );
  });
});

describe('arming', () => {
  it('starts a countdown that fires one cancel window later', () => {
    const state = armed();

    expect(state.phase).toBe('countdown');
    expect(state.trigger).toEqual({
      signature: 'respiratory.spo2.critical',
      criticalRules: CRITICAL,
      manual: false,
      armedAt: T0,
      firesAt: T0 + 30_000,
    });
  });

  it('does nothing at all when nothing is firing', () => {
    // Same reference, not merely equal: the hook renders on every risk re-evaluation and a new
    // object here would re-render the whole Dashboard once a minute for no reason.
    const state = sosReducer(INITIAL_SOS_STATE, assess({ signature: null }), CONFIG);

    expect(state).toBe(INITIAL_SOS_STATE);
  });

  it('clears the previous result so a stale outcome is not shown behind a new countdown', () => {
    // Not dismissed: the failure modal is still on screen when a second, different emergency
    // fires. Carrying `result` into the countdown would render "delivery failed" underneath a
    // live 30-second window for an alert that has not been attempted yet.
    const failed = reduce(
      INITIAL_SOS_STATE,
      assess(),
      { type: 'tick', now: T0 + 30_000 },
      { type: 'dispatched', result: result({ failed: true }), now: T0 + 31_000 },
    );
    expect(failed.phase).toBe('failed');
    expect(failed.result).not.toBeNull();

    const next = sosReducer(
      failed,
      assess({
        signature: 'fall.impactThenStillness',
        criticalRules: ['fall.impactThenStillness'],
        now: T0 + 40_000,
      }),
      CONFIG,
    );

    expect(next.phase).toBe('countdown');
    expect(next.result).toBeNull();
  });
});

describe('the cancel window boundary', () => {
  it('does not fire one millisecond early', () => {
    const state = reduce(armed(), { type: 'tick', now: T0 + 29_999 });

    expect(state.phase).toBe('countdown');
  });

  it('fires at exactly firesAt', () => {
    // The one instant that matters, and the reason the reducer takes `now` as an argument.
    // `>` instead of `>=` here would leave the alert waiting for the next tick — up to 250 ms
    // in the hook, and forever if the clock stops.
    const state = reduce(armed(), { type: 'tick', now: T0 + 30_000 });

    expect(state.phase).toBe('dispatching');
  });

  it('fires on a tick that overshoots, rather than missing the window', () => {
    // A backgrounded app does not tick on schedule. Anything past `firesAt` must still fire.
    const state = reduce(armed(), { type: 'tick', now: T0 + 120_000 });

    expect(state.phase).toBe('dispatching');
  });

  it('ignores ticks when nothing is armed', () => {
    expect(sosReducer(INITIAL_SOS_STATE, { type: 'tick', now: T0 }, CONFIG)).toBe(
      INITIAL_SOS_STATE,
    );
  });

  it('will not re-arm while a countdown is running, even on a worse rule set', () => {
    // Re-arming would reset the 30 seconds and *delay* the alert — precisely backwards for a
    // situation that is deteriorating.
    const state = reduce(
      armed(),
      assess({
        signature: 'fall.impactThenStillness|respiratory.spo2.critical',
        criticalRules: ['fall.impactThenStillness', 'respiratory.spo2.critical'],
        now: T0 + 10_000,
      }),
    );

    expect(state.phase).toBe('countdown');
    expect(state.trigger?.firesAt).toBe(T0 + 30_000); // untouched
  });

  it('will not re-arm mid-dispatch', () => {
    const dispatching = reduce(armed(), { type: 'tick', now: T0 + 30_000 });
    const state = reduce(dispatching, assess({ signature: 'other', now: T0 + 31_000 }));

    expect(state).toBe(dispatching);
  });
});

describe('cancelling', () => {
  it('suppresses this emergency', () => {
    const state = reduce(armed(), { type: 'cancel', now: T0 + 5_000 });

    expect(state.phase).toBe('cancelled');
    expect(state.suppressedSignature).toBe('respiratory.spo2.critical');
    expect(state.trigger).toBeNull();
  });

  it('stays quiet while the same rules keep firing', () => {
    let state = reduce(armed(), { type: 'cancel', now: T0 + 5_000 }, { type: 'dismiss' });

    // Well past the cooldown, so suppression is doing the work and not the timer.
    for (const minute of [1, 5, 10, 60]) {
      state = reduce(state, assess({ now: T0 + minute * 60_000 }));
      expect(state.phase).toBe('idle');
    }
  });

  it('does not deafen the app to a different emergency', () => {
    // The reason suppression is keyed on the signature. A cancelled low-SpO2 alert must not
    // swallow a fall three minutes later.
    const cancelled = reduce(armed(), { type: 'cancel', now: T0 + 5_000 }, { type: 'dismiss' });

    const state = reduce(
      cancelled,
      assess({
        signature: 'fall.impactThenStillness',
        criticalRules: ['fall.impactThenStillness'],
        now: T0 + 180_000,
      }),
    );

    expect(state.phase).toBe('countdown');
  });

  it('re-alerts on a later episode of the same rule, once it stopped firing in between', () => {
    // Recovery is what clears suppression: `signature: null` on a tick where nothing fires.
    // Without this, one cancel would silence that rule for the rest of the session.
    const state = reduce(
      armed(),
      { type: 'cancel', now: T0 + 5_000 },
      { type: 'dismiss' },
      assess({ signature: null, now: T0 + 60_000 }), // recovered
      assess({ now: T0 + 600_000 }), // fresh episode, past the cooldown
    );

    expect(state.phase).toBe('countdown');
    expect(state.suppressedSignature).toBeNull();
  });

  it('only cancels a live countdown', () => {
    // A cancel arriving after the window closed must not appear to have stopped anything.
    const dispatching = reduce(armed(), { type: 'tick', now: T0 + 30_000 });

    expect(reduce(dispatching, { type: 'cancel', now: T0 + 30_001 })).toBe(dispatching);
    expect(sosReducer(INITIAL_SOS_STATE, { type: 'cancel', now: T0 }, CONFIG)).toBe(
      INITIAL_SOS_STATE,
    );
  });
});

describe('the cooldown', () => {
  /** Dispatched at T0, so the cooldown runs to T0 + 300_000. */
  function dispatched(): SosMachineState {
    return reduce(
      armed(),
      { type: 'tick', now: T0 + 30_000 },
      { type: 'dispatched', result: result(), now: T0 },
      { type: 'dismiss' },
    );
  }

  it('stops a persistent rule from re-texting every evaluation tick', () => {
    // `heat.stillness.critical` is true for as long as the user is still, by construction. This
    // is the case that would otherwise send an SMS a minute, forever.
    let state = dispatched();

    for (const minute of [1, 2, 3, 4]) {
      state = reduce(state, assess({ now: T0 + minute * 60_000 }));
      expect(state.phase).toBe('idle');
    }
  });

  it('expires, so a rule still firing after the window alerts again', () => {
    expect(reduce(dispatched(), assess({ now: T0 + 299_999 })).phase).toBe('idle');
    expect(reduce(dispatched(), assess({ now: T0 + 300_000 })).phase).toBe('countdown');
  });

  it('is keyed on the signature, so a new emergency is not held back by it', () => {
    const state = reduce(
      dispatched(),
      assess({
        signature: 'fall.impactThenStillness',
        criticalRules: ['fall.impactThenStillness'],
        now: T0 + 1_000,
      }),
    );

    expect(state.phase).toBe('countdown');
  });

  it('applies to refusals too, so "add a contact" does not reappear every minute', () => {
    const refused = reduce(INITIAL_SOS_STATE, assess({ hasContacts: false }), { type: 'dismiss' });

    expect(refused.handledAt).toBe(T0);
    expect(reduce(refused, assess({ hasContacts: false, now: T0 + 60_000 })).phase).toBe('idle');
  });

  it('survives dismissal — dismissing is acknowledging, not resetting', () => {
    const state = reduce(dispatched(), assess({ now: T0 + 60_000 }));

    expect(state.phase).toBe('idle');
    expect(state.handledAt).toBe(T0);
  });

  it('is not cleared by recovery, unlike suppression', () => {
    // Suppression clears on `signature: null` because the user's "no" was about a specific
    // episode. The cooldown is time-based and expires on its own; clearing it here would let a
    // flickering rule (fires, clears, fires) re-text on every flicker.
    const state = reduce(
      dispatched(),
      assess({ signature: null, now: T0 + 30_000 }),
      assess({ now: T0 + 60_000 }),
    );

    expect(state.phase).toBe('idle');
  });
});

describe('a manual press', () => {
  it('arms a countdown like a rule trigger, flagged manual and carrying no rules', () => {
    const state = reduce(INITIAL_SOS_STATE, manual());

    expect(state.phase).toBe('countdown');
    expect(state.trigger?.manual).toBe(true);
    expect(state.trigger?.criticalRules).toEqual([]);
    expect(state.trigger?.firesAt).toBe(T0 + 30_000);
  });

  it('ignores the cooldown, because refusing a deliberate press is the wrong failure', () => {
    const justDispatched = reduce(
      INITIAL_SOS_STATE,
      assess(),
      { type: 'tick', now: T0 + 30_000 },
      { type: 'dispatched', result: result(), now: T0 + 30_000 },
      { type: 'dismiss' },
    );

    expect(reduce(justDispatched, manual({ now: T0 + 31_000 })).phase).toBe('countdown');
  });

  it('ignores suppression — a second press means they meant it', () => {
    const cancelled = reduce(
      INITIAL_SOS_STATE,
      manual(),
      { type: 'cancel', now: T0 + 5_000 },
      { type: 'dismiss' },
    );

    expect(reduce(cancelled, manual({ now: T0 + 6_000 })).phase).toBe('countdown');
  });

  it('never suppresses a signature when cancelled, since each press is unique', () => {
    const state = reduce(INITIAL_SOS_STATE, manual(), { type: 'cancel', now: T0 + 5_000 });

    expect(state.phase).toBe('cancelled');
    // A `manual:<timestamp>` signature can never recur, so storing it would be dead state that
    // reads like a suppression the user never asked for.
    expect(state.suppressedSignature).toBeNull();
  });

  it('is ignored mid-countdown rather than restarting the window', () => {
    const state = reduce(armed(), manual({ now: T0 + 10_000 }));

    expect(state.trigger?.firesAt).toBe(T0 + 30_000);
    expect(state.trigger?.manual).toBe(false);
  });

  it('still respects consent and contacts', () => {
    expect(reduce(INITIAL_SOS_STATE, manual({ consent: false })).phase).toBe('no_consent');
    expect(reduce(INITIAL_SOS_STATE, manual({ hasContacts: false })).phase).toBe('no_contacts');
  });

  it('does not set a cooldown anchor when refused', () => {
    // Unlike an automatic refusal: a person who presses the button, reads "add a contact", adds
    // one, and presses again must be served immediately.
    const refused = reduce(INITIAL_SOS_STATE, manual({ hasContacts: false }), { type: 'dismiss' });

    expect(refused.handledAt).toBeNull();
    expect(reduce(refused, manual({ now: T0 + 1_000 })).phase).toBe('countdown');
  });
});

describe('refusals', () => {
  it('reports missing consent instead of silently doing nothing', () => {
    const state = reduce(INITIAL_SOS_STATE, assess({ consent: false }));

    expect(state.phase).toBe('no_consent');
    expect(state.trigger).toBeNull();
  });

  it('reports an empty contact list instead of silently doing nothing', () => {
    const state = reduce(INITIAL_SOS_STATE, assess({ hasContacts: false }));

    expect(state.phase).toBe('no_contacts');
    expect(state.trigger).toBeNull();
  });

  it('checks consent before contacts', () => {
    // Both missing: the opt-in is the more fundamental answer, and telling someone to add a
    // contact when the feature is switched off would send them to fix the wrong thing.
    expect(reduce(INITIAL_SOS_STATE, assess({ consent: false, hasContacts: false })).phase).toBe(
      'no_consent',
    );
  });

  it('respects a cancel that came before — a refusal must not resurface a suppressed alert', () => {
    const cancelled = reduce(armed(), { type: 'cancel', now: T0 + 5_000 }, { type: 'dismiss' });
    const state = reduce(cancelled, assess({ consent: false, now: T0 + 600_000 }));

    expect(state.phase).toBe('idle');
  });
});

describe('dispatch outcomes', () => {
  function dispatching(): SosMachineState {
    return reduce(armed(), { type: 'tick', now: T0 + 30_000 });
  }

  it('maps a delivered alert to sent', () => {
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result({ relayDelivered: [{ contactId: 'c1', channels: ['telegram'] }] }),
      now: T0 + 31_000,
    });

    expect(state.phase).toBe('sent');
    expect(state.result?.relayDelivered).toEqual([{ contactId: 'c1', channels: ['telegram'] }]);
    expect(state.trigger).toBeNull();
  });

  it('maps an unsent composer to sms_pending, not sent', () => {
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result({ nativeSmsPending: true }),
      now: T0 + 31_000,
    });

    expect(state.phase).toBe('sms_pending');
  });

  it('lets pending outrank sent when the relay reached only some contacts', () => {
    // Two contacts, one relayed and one waiting on a tap. "Sent" would be a lie about the
    // second, and the second is the one that needs the user to do something.
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result({
        relayDelivered: [{ contactId: 'c1', channels: ['textbelt'] }],
        nativeSmsPending: true,
      }),
      now: T0 + 31_000,
    });

    expect(state.phase).toBe('sms_pending');
  });

  it('lets failure outrank everything', () => {
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result({ failed: true, nativeSmsPending: true }),
      now: T0 + 31_000,
    });

    expect(state.phase).toBe('failed');
  });

  it('anchors the cooldown at the dispatch, not at the trigger', () => {
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result(),
      now: T0 + 31_000,
    });

    expect(state.handledAt).toBe(T0 + 31_000);
    expect(state.handledSignature).toBe('respiratory.spo2.critical');
  });

  it('sets the cooldown even on failure, so a broken relay is not retried every minute', () => {
    // Debatable in principle — but the alternative retries a failing send once a minute while
    // the user watches an error they cannot act on, and the manual button is the escape hatch.
    const state = reduce(dispatching(), {
      type: 'dispatched',
      result: result({ failed: true }),
      now: T0 + 31_000,
    });

    expect(state.handledAt).toBe(T0 + 31_000);
    expect(reduce(state, { type: 'dismiss' }, assess({ now: T0 + 60_000 })).phase).toBe('idle');
  });

  it('ignores a result that arrives when nothing is dispatching', () => {
    const cancelled = reduce(armed(), { type: 'cancel', now: T0 + 5_000 });
    const event: SosEvent = { type: 'dispatched', result: result(), now: T0 + 6_000 };

    // A late result from an aborted attempt must not overwrite the cancelled state and tell the
    // user their alert went out after they stopped it.
    expect(reduce(cancelled, event)).toBe(cancelled);
    expect(sosReducer(INITIAL_SOS_STATE, event, CONFIG)).toBe(INITIAL_SOS_STATE);
  });
});

describe('dismissing', () => {
  it('returns to idle from every terminal phase', () => {
    const terminal: readonly SosMachineState[] = [
      reduce(armed(), { type: 'cancel', now: T0 + 1 }),
      reduce(armed(), { type: 'tick', now: T0 + 30_000 }, {
        type: 'dispatched',
        result: result(),
        now: T0 + 30_000,
      }),
      reduce(armed(), { type: 'tick', now: T0 + 30_000 }, {
        type: 'dispatched',
        result: result({ nativeSmsPending: true }),
        now: T0 + 30_000,
      }),
      reduce(armed(), { type: 'tick', now: T0 + 30_000 }, {
        type: 'dispatched',
        result: result({ failed: true }),
        now: T0 + 30_000,
      }),
      reduce(INITIAL_SOS_STATE, assess({ hasContacts: false })),
      reduce(INITIAL_SOS_STATE, assess({ consent: false })),
    ];

    for (const state of terminal) {
      const dismissed = sosReducer(state, { type: 'dismiss' }, CONFIG);
      expect(dismissed.phase).toBe('idle');
      expect(dismissed.result).toBeNull();
      expect(dismissed.trigger).toBeNull();
    }
  });

  it('cannot dismiss an armed or in-flight alert', () => {
    // The modal hides its dismiss affordance in these phases, but the reducer refuses anyway:
    // a stray dismiss during the countdown would silently drop the alert with no cancel record.
    const countdown = armed();
    const dispatching = reduce(countdown, { type: 'tick', now: T0 + 30_000 });

    expect(sosReducer(countdown, { type: 'dismiss' }, CONFIG)).toBe(countdown);
    expect(sosReducer(dispatching, { type: 'dismiss' }, CONFIG)).toBe(dispatching);
  });

  it('keeps suppression, so acknowledging a cancel does not undo it', () => {
    const state = reduce(armed(), { type: 'cancel', now: T0 + 1 }, { type: 'dismiss' });

    expect(state.suppressedSignature).toBe('respiratory.spo2.critical');
  });
});

describe('countdown display', () => {
  it('counts down within the window', () => {
    const state = armed();

    expect(countdownRemainingMs(state, T0)).toBe(30_000);
    expect(countdownRemainingMs(state, T0 + 12_500)).toBe(17_500);
    expect(countdownRemainingMs(state, T0 + 30_000)).toBe(0);
  });

  it('floors at zero rather than going negative on a late tick', () => {
    expect(countdownRemainingMs(armed(), T0 + 45_000)).toBe(0);
  });

  it('rounds up, so the user never reads 0 while they can still cancel', () => {
    // The failure this prevents: a display that shows "0" for a whole second during which a
    // cancel would still work, so the user believes it is too late and stops trying.
    const state = armed();

    expect(countdownSeconds(state, T0)).toBe(30);
    expect(countdownSeconds(state, T0 + 1)).toBe(30);
    expect(countdownSeconds(state, T0 + 1_000)).toBe(29);
    expect(countdownSeconds(state, T0 + 29_999)).toBe(1);
    expect(countdownSeconds(state, T0 + 30_000)).toBe(0);
  });

  it('reads zero whenever nothing is armed', () => {
    for (const state of [
      INITIAL_SOS_STATE,
      reduce(armed(), { type: 'tick', now: T0 + 30_000 }), // dispatching
      reduce(armed(), { type: 'cancel', now: T0 + 1 }),
    ]) {
      expect(countdownRemainingMs(state, T0)).toBe(0);
      expect(countdownSeconds(state, T0)).toBe(0);
    }
  });
});

describe('the shipped configuration', () => {
  it('uses the PRD’s 30-second cancel window', () => {
    // PRD §7.2.5 names the number. The tests above use a local config for readability, so this
    // is the one place that pins what actually ships.
    expect(DEFAULT_SOS_MACHINE_CONFIG.cancelWindowMs).toBe(30_000);
  });

  it('applies by default, with no config argument', () => {
    const state = sosReducer(INITIAL_SOS_STATE, assess());

    expect(state.trigger?.firesAt).toBe(T0 + DEFAULT_SOS_MACHINE_CONFIG.cancelWindowMs);
    expect(sosReducer(state, { type: 'tick', now: T0 + 29_999 }).phase).toBe('countdown');
    expect(sosReducer(state, { type: 'tick', now: T0 + 30_000 }).phase).toBe('dispatching');
  });

  it('sets a cooldown longer than the risk engine’s evaluation interval', () => {
    // The whole point of the cooldown. If it were shorter than the re-evaluation period, a
    // persistent rule would re-arm on the very next tick and the guard would do nothing —
    // this project's recurring bug class, a threshold made unreachable by the real cadence.
    // See `use-risk-assessment.ts` (60 s) and PRD §7.2.1's 30–60 s polling.
    expect(DEFAULT_SOS_MACHINE_CONFIG.cooldownMs).toBeGreaterThan(60_000);
  });
});
