import { describe, expect, it } from 'vitest';

import { TELEGRAM_API_BASE } from '../src/adapters/telegram';
import {
  handleTelegramUpdate,
  isLinkToken,
  LINK_TTL_SECONDS,
  LINKED_MESSAGE,
  redeemLink,
  START_HELP,
  storeLink,
  telegramDeepLink,
} from '../src/link';
import { CHAT_ID, FAKE, LINK_TOKEN_A, LINK_TOKEN_B, makeEnv } from './helpers/env';
import { FakeKV } from './helpers/fake-kv';
import { stubFetchJson, stubFetchNetworkError } from './helpers/fetch';

function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('link tokens', () => {
  it('accepts exactly 22 base64url characters', () => {
    expect(isLinkToken(LINK_TOKEN_A)).toBe(true);
    expect(isLinkToken('A'.repeat(22))).toBe(true);
    expect(isLinkToken('A'.repeat(21))).toBe(false);
    expect(isLinkToken('A'.repeat(23))).toBe(false);
    expect(isLinkToken('A'.repeat(20) + '+/')).toBe(false); // standard base64, not base64url
    expect(isLinkToken('A'.repeat(20) + '==')).toBe(false); // padding
    expect(isLinkToken('123456')).toBe(false); // the old six-digit code shape is gone
  });

  it('builds the deep link with or without a leading @', () => {
    expect(telegramDeepLink('phc_bot', LINK_TOKEN_A)).toBe(`https://t.me/phc_bot?start=${LINK_TOKEN_A}`);
    expect(telegramDeepLink('@phc_bot', LINK_TOKEN_A)).toBe(`https://t.me/phc_bot?start=${LINK_TOKEN_A}`);
  });

  it('storeLink keeps the chat id under the token with a 10-minute TTL', async () => {
    const kv = new FakeKV();
    await storeLink(kv, LINK_TOKEN_A, CHAT_ID);
    expect(kv.puts).toEqual([{ key: `link:${LINK_TOKEN_A}`, value: CHAT_ID, expirationTtl: LINK_TTL_SECONDS }]);
    expect(LINK_TTL_SECONDS).toBe(600);
  });

  it('redeemLink is one-time', async () => {
    const kv = new FakeKV();
    await storeLink(kv, LINK_TOKEN_A, CHAT_ID);
    expect(await redeemLink(kv, LINK_TOKEN_A)).toBe(CHAT_ID);
    expect(await redeemLink(kv, LINK_TOKEN_A)).toBeNull();
    expect(kv.size).toBe(0);
  });

  it('redeemLink returns null before the caregiver has tapped', async () => {
    expect(await redeemLink(new FakeKV(), LINK_TOKEN_A)).toBeNull();
  });

  it('a link expires after ten minutes', async () => {
    const time = clock();
    const kv = new FakeKV(time.now);
    await storeLink(kv, LINK_TOKEN_A, CHAT_ID);
    time.advance(LINK_TTL_SECONDS * 1000 - 1);
    expect(await kv.get(`link:${LINK_TOKEN_A}`)).toBe(CHAT_ID);
    time.advance(1);
    expect(await redeemLink(kv, LINK_TOKEN_A)).toBeNull();
  });

  it('two tokens link two chats independently', async () => {
    const kv = new FakeKV();
    await storeLink(kv, LINK_TOKEN_A, 'chat-a');
    await storeLink(kv, LINK_TOKEN_B, 'chat-b');
    expect(await redeemLink(kv, LINK_TOKEN_B)).toBe('chat-b');
    expect(await redeemLink(kv, LINK_TOKEN_A)).toBe('chat-a');
  });
});

describe('handleTelegramUpdate', () => {
  const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken });
  const update = (text: string, chatId: number | string = 123_456_789) => ({
    update_id: 1,
    message: { message_id: 1, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'A' } },
  });

  it('on `/start <token>` stores the chat id under the token and replies "linked"', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update(`/start ${LINK_TOKEN_A}`), env, kv);

    expect(outcome).toEqual({ kind: 'linked', chatId: '123456789', linkToken: LINK_TOKEN_A });
    expect(await kv.get(`link:${LINK_TOKEN_A}`)).toBe('123456789');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe(`${TELEGRAM_API_BASE}/bot${FAKE.telegramToken}/sendMessage`);
    expect(stub.calls[0]!.json).toMatchObject({ chat_id: '123456789', text: LINKED_MESSAGE });
    expect(LINKED_MESSAGE).toBe('Linked to Raksha. You will receive emergency alerts here.');
  });

  it('accepts the bot-mention form', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    expect((await handleTelegramUpdate(update(`/start@phc_bot ${LINK_TOKEN_A}`), env, kv)).kind).toBe('linked');
  });

  it.each([
    ['/start'],
    ['/start '],
    ['/start 123456'],
    [`/start ${LINK_TOKEN_A}x`],
    [`/start ${LINK_TOKEN_A} extra`],
    ['/start A'.padEnd(80, 'A')],
    ['hello?'],
  ])('replies with help and stores nothing for %j', async (text) => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update(text), env, kv);
    expect(outcome).toEqual({ kind: 'help', chatId: '123456789' });
    expect(kv.size).toBe(0);
    expect(stub.calls[0]!.json).toMatchObject({ text: START_HELP });
  });

  it('help and linked copy talk about emergency alerts, never a diagnosis', () => {
    expect(START_HELP).toMatch(/emergency alerts/);
    expect(LINKED_MESSAGE).toMatch(/emergency alerts/);
    expect(`${START_HELP} ${LINKED_MESSAGE}`).not.toMatch(/diagnos/i);
  });

  it('ignores updates without a message text or chat', async () => {
    const stub = stubFetchJson(200, { ok: true });
    expect(await handleTelegramUpdate({ update_id: 2, edited_message: {} }, env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(await handleTelegramUpdate({ message: { chat: { id: 1 } } }, env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(await handleTelegramUpdate('garbage', env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('ignores everything when no bot token is configured', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    expect(await handleTelegramUpdate(update(`/start ${LINK_TOKEN_A}`), makeEnv(), kv)).toEqual({ kind: 'ignored' });
    expect(kv.size).toBe(0);
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('a failed reply does not throw and the link stays stored', async () => {
    stubFetchNetworkError();
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update(`/start ${LINK_TOKEN_A}`), env, kv);
    expect(outcome).toEqual({ kind: 'linked', chatId: '123456789', linkToken: LINK_TOKEN_A });
    expect(await kv.get(`link:${LINK_TOKEN_A}`)).toBe('123456789');
  });

  it('stringifies numeric and string chat ids alike', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    await handleTelegramUpdate(update(`/start ${LINK_TOKEN_A}`, '-1001'), env, kv);
    expect(await kv.get(`link:${LINK_TOKEN_A}`)).toBe('-1001');
  });
});
