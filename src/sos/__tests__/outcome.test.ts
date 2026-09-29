/**
 * Per-contact outcome lines for the SOS overlay.
 *
 * The line a user reads after an alert is the one place the difference between "delivered"
 * and "waiting for your tap" has to survive contact with real prose, so each shape gets a test:
 * a wrong word here is the difference between someone putting the phone down and someone
 * pressing send.
 */

import { describeDispatch } from '@/sos/outcome';
import type { EmergencyContact, SosDispatchResult } from '@/sos/types';

const MEERA: EmergencyContact = { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210' };
const RAJ: EmergencyContact = { id: 'c2', name: 'Raj', relation: '', phone: '+919123456780' };

function result(overrides: Partial<SosDispatchResult>): SosDispatchResult {
  return {
    attempts: [],
    relayDelivered: [],
    nativeSmsPending: false,
    failed: false,
    message: 'RAKSHA EMERGENCY',
    ...overrides,
  };
}

describe('describeDispatch', () => {
  it('names the channel that carried a relay delivery', () => {
    const lines = describeDispatch(
      result({ relayDelivered: [{ contactId: 'c1', channels: ['telegram'] }] }),
      [MEERA, RAJ],
    );
    expect(lines).toEqual([{ contactId: 'c1', text: 'Sent to Meera via Telegram' }]);
  });

  it('collapses the two SMS gateways into "SMS" and joins with "and"', () => {
    // Which gateway carried it is an operator's concern, not the user's. "Telegram and SMS"
    // says what they need: the person has it on two channels.
    const lines = describeDispatch(
      result({
        relayDelivered: [
          { contactId: 'c1', channels: ['telegram', 'textbelt'] },
          { contactId: 'c2', channels: ['twilio'] },
        ],
      }),
      [MEERA, RAJ],
    );
    expect(lines.map((l) => l.text)).toEqual(['Sent to Meera via Telegram and SMS', 'Sent to Raj via SMS']);
  });

  it('says "sent" without a channel when the relay confirmed but named none', () => {
    const lines = describeDispatch(result({ relayDelivered: [{ contactId: 'c1', channels: [] }] }), [MEERA]);
    expect(lines[0].text).toBe('Sent to Meera');
  });

  it('says the SMS app opened, not sent, for a composer fallback', () => {
    const lines = describeDispatch(
      result({
        nativeSmsPending: true,
        attempts: [{ contactId: 'c2', phone: RAJ.phone, channel: 'native_sms', ok: true }],
      }),
      [MEERA, RAJ],
    );
    expect(lines).toEqual([{ contactId: 'c2', text: 'Opened SMS app for Raj' }]);
  });

  it('does not claim the SMS app is open when the user dismissed it', () => {
    const lines = describeDispatch(
      result({
        nativeSmsPending: false,
        attempts: [{ contactId: 'c2', phone: RAJ.phone, channel: 'native_sms', ok: true }],
      }),
      [MEERA, RAJ],
    );
    expect(lines).toEqual([{ contactId: 'c2', text: 'SMS app dismissed for Raj' }]);
  });

  it('says who could not be reached at all', () => {
    const lines = describeDispatch(
      result({
        failed: true,
        attempts: [
          { contactId: 'c2', phone: RAJ.phone, channel: 'textbelt', ok: false, error: 'x' },
          { contactId: 'c2', phone: RAJ.phone, channel: 'native_sms', ok: false, error: 'y' },
        ],
      }),
      [MEERA, RAJ],
    );
    expect(lines).toEqual([{ contactId: 'c2', text: 'Could not reach Raj' }]);
  });

  it('keeps the contact list order and one line per contact', () => {
    const lines = describeDispatch(
      result({
        relayDelivered: [{ contactId: 'c2', channels: ['telegram'] }],
        nativeSmsPending: true,
        attempts: [
          { contactId: 'c1', phone: MEERA.phone, channel: 'textbelt', ok: false, error: 'x' },
          { contactId: 'c1', phone: MEERA.phone, channel: 'native_sms', ok: true },
          { contactId: 'c2', phone: RAJ.phone, channel: 'telegram', ok: true },
        ],
      }),
      [MEERA, RAJ],
    );
    expect(lines.map((l) => l.text)).toEqual(['Opened SMS app for Meera', 'Sent to Raj via Telegram']);
  });

  it('skips a contact that is no longer in the list rather than inventing a name', () => {
    // The list can change between dispatch and render (an edit in Settings on another tab).
    // The full per-channel record is still in `attempts` for the failed-phase list.
    const lines = describeDispatch(
      result({ relayDelivered: [{ contactId: 'gone', channels: ['telegram'] }] }),
      [MEERA],
    );
    expect(lines).toEqual([]);
  });
});
