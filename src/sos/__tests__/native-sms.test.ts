/**
 * Native SMS fallback tests.
 *
 * The single most important assertion in this file is that `sent` is not conflated with
 * delivered anywhere, and its counterpart: that **one** composer is opened for the whole
 * contact list. On iOS only one composer can be on screen at a time, so a per-contact loop
 * would leave the second contact's message queued behind the first with nothing on screen
 * saying it existed — an alert the user believes went out and which never will.
 *
 * The availability gate is tested for the same reason it exists: on a tablet, an emulator, or a
 * device with no SIM, `sendSMSAsync` rejects with a message that reads like an app bug rather
 * than a missing radio, and this is the fallback path — the moment it looks like a bug is the
 * moment someone stops trusting the SOS button.
 */

import { sendViaNativeSms, type NativeSmsOptions } from '@/sos/native-sms';

const MESSAGE = 'RAKSHA EMERGENCY - Asha needs help.';
const RECIPIENTS = ['+919876543210', '+919123456780'];

type SmsImpl = NonNullable<NativeSmsOptions['smsImpl']>;

function smsImpl(
  overrides: {
    available?: boolean;
    result?: string;
    availableRejects?: boolean;
    sendRejects?: boolean;
  } = {},
): jest.Mocked<SmsImpl> {
  const {
    available = true,
    result = 'sent',
    availableRejects = false,
    sendRejects = false,
  } = overrides;

  return {
    isAvailableAsync: jest.fn(() =>
      availableRejects ? Promise.reject(new Error('boom')) : Promise.resolve(available),
    ),
    // Parameters are declared even though the body ignores them: `jest.fn(() => …)` infers a
    // zero-argument mock, which makes `mock.calls[0][0]` a type error and stops the double from
    // being assignable to the real signature.
    sendSMSAsync: jest.fn((_recipients: string | string[], _message: string) =>
      sendRejects ? Promise.reject(new Error('boom')) : Promise.resolve({ result }),
    ),
  };
}

describe('sendViaNativeSms', () => {
  it('opens exactly one composer addressed to every recipient', async () => {
    const sms = smsImpl();

    const result = await sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: sms });

    expect(result).toEqual({ ok: true, outcome: 'sent' });
    // One call, not one per contact. See the header — this is the assertion that keeps the
    // second contact's alert from vanishing behind the first on iOS.
    expect(sms.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(sms.sendSMSAsync).toHaveBeenCalledWith(RECIPIENTS, MESSAGE);
  });

  it('passes a copy of the recipient list, not the caller’s array', async () => {
    // `expo-sms` hands the array across the native bridge. Passing the caller's readonly array
    // through would be a latent aliasing bug the first time anything downstream mutated it.
    const sms = smsImpl();

    await sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: sms });

    expect(sms.sendSMSAsync.mock.calls[0][0]).not.toBe(RECIPIENTS);
    expect(sms.sendSMSAsync.mock.calls[0][0]).toEqual(RECIPIENTS);
  });

  it('checks availability before trying to send', async () => {
    const sms = smsImpl({ available: false });

    await expect(sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: sms })).resolves.toEqual({
      ok: false,
      error: 'This device cannot send SMS.',
    });
    expect(sms.sendSMSAsync).not.toHaveBeenCalled();
  });

  it('reports each documented composer outcome distinctly', async () => {
    for (const outcome of ['sent', 'cancelled', 'unknown'] as const) {
      const sms = smsImpl({ result: outcome });

      await expect(sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: sms })).resolves.toEqual({
        ok: true,
        outcome,
      });
    }
  });

  it('treats an unrecognised outcome as unknown rather than as a failure', async () => {
    // Version skew in `expo-sms`. The composer did open, which is all this path ever promises,
    // so reporting a failure here would send the caller into a fallback that does not exist.
    const sms = smsImpl({ result: 'something-new' });

    await expect(sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: sms })).resolves.toEqual({
      ok: true,
      outcome: 'unknown',
    });
  });

  it('refuses an empty recipient list instead of opening an empty composer', async () => {
    const sms = smsImpl();

    await expect(sendViaNativeSms([], MESSAGE, { smsImpl: sms })).resolves.toEqual({
      ok: false,
      error: 'No emergency contacts to message.',
    });
    expect(sms.isAvailableAsync).not.toHaveBeenCalled();
    expect(sms.sendSMSAsync).not.toHaveBeenCalled();
  });

  it('never throws, whichever call rejects', async () => {
    // This is the last path in the escalation. An exception escaping here has nothing below it
    // to catch the alert.
    await expect(
      sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: smsImpl({ availableRejects: true }) }),
    ).resolves.toEqual({ ok: false, error: 'Could not open the SMS composer.' });

    await expect(
      sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: smsImpl({ sendRejects: true }) }),
    ).resolves.toEqual({ ok: false, error: 'Could not open the SMS composer.' });
  });

  it('never reports this path as delivered', async () => {
    // The type has no `sent: true` to return, and that is deliberate — `outcome: 'sent'` means
    // the platform reported the send action was taken, which is the strongest claim available
    // and still not a delivery receipt. Asserted so a future "simplification" that collapses
    // `outcome` into a boolean has to argue with a test.
    const result = await sendViaNativeSms(RECIPIENTS, MESSAGE, { smsImpl: smsImpl() });

    expect(result).not.toHaveProperty('delivered');
    expect(Object.keys(result).sort()).toEqual(['ok', 'outcome']);
  });
});
