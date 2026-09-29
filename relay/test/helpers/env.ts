import type { Env } from '../../src/env';
import { FakeKV } from './fake-kv';

/** Fake tokens only — nothing here is a real credential. */
export const FAKE = {
  telegramToken: 'test-token',
  webhookSecret: 'test-webhook-secret',
  textbeltKey: 'test-textbelt-key',
  twilioSid: 'ACtest',
  twilioToken: 'test-twilio-token',
  twilioFrom: '+15005550006',
  appKey: 'test-app-key',
} as const;

export function makeEnv(overrides: Partial<Env> = {}, kv: FakeKV = new FakeKV()): Env {
  return { LINKS: kv.asNamespace(), CHANNEL_ORDER: 'telegram,textbelt', ...overrides };
}

/** Env with every real adapter configured (telegram, textbelt, twilio). */
export function fullEnv(overrides: Partial<Env> = {}, kv?: FakeKV): Env {
  return makeEnv(
    {
      TELEGRAM_BOT_TOKEN: FAKE.telegramToken,
      TEXTBELT_KEY: FAKE.textbeltKey,
      TWILIO_ACCOUNT_SID: FAKE.twilioSid,
      TWILIO_AUTH_TOKEN: FAKE.twilioToken,
      TWILIO_FROM: FAKE.twilioFrom,
      ...overrides,
    },
    kv,
  );
}

export const PHONE = '+919876543210';
/** 22 base64url chars = 128 bits. Fixed fixtures, not real tokens. */
export const LINK_TOKEN_A = 'AbCdEfGhIjKlMnOpQrStUv';
export const LINK_TOKEN_B = 'Zy_x-WvUtSrQpOnMlKjIhG';
export const CHAT_ID = '123456789';
export const MESSAGE = 'RAKSHA EMERGENCY - Asha needs help. Possible fall detected. Location: https://maps.google.com/?q=12.97,77.59';
