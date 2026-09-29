# PHC emergency alert relay (Cloudflare Worker)

The phone POSTs one emergency alert per contact to this Worker; the Worker delivers it over
whichever channels are configured — **Telegram** (primary, free), **Textbelt** SMS (free tier: one
per day), **Twilio** SMS (built, disabled until credentials exist) — and reports per-channel results.
Every provider credential lives in the Worker's environment. The app knows one URL and nothing else.

Design: [`docs/superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md`](../docs/superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md) ·
contract: [`docs/features/sos-relay.md`](../docs/features/sos-relay.md) ·
decision: [`docs/decisions/ADR-007-multi-channel-relay.md`](../docs/decisions/ADR-007-multi-channel-relay.md).

## Status — read this first

| Adapter | Built | Unit tested (mocked `fetch`) | Validated against the real provider |
| --- | --- | --- | --- |
| `telegram` | yes | yes | **YES** — 2026-09-21: deployed at `phc-sos-relay.xreep.workers.dev`; `/start <linkToken>` → `/link` → `/sos` delivered a message to a real Telegram account in ~1 s |
| `textbelt` | yes | yes | **Tested, blocked for India** — 2026-09-21: Textbelt answered `Sorry, free SMS are disabled for this country due to abuse`; the relay returned 502 as designed (phone falls back to the SMS composer). Paid tier unverified. |
| `twilio` | yes | yes | **NO** — no credentials; disabled |
| `fcm` | stub | yes (returns "not implemented") | — (M5 part 2) |

Nothing in this directory has sent a real message to a real phone. The unit tests prove the request
shapes and the failure handling against a stubbed network; the first `wrangler deploy` plus the smoke
test at the end of this page is what turns a row above into "validated". Update the table when it
happens.

## Layout

```
relay/
  wrangler.toml        name, compatibility date, [vars], KV binding — no secrets
  src/index.ts         router: POST /sos, POST /link, POST /telegram/webhook, GET /health
  src/contract.ts      request/response types + validation (legacy body accepted)
  src/dispatch.ts      channel order, stop rule, SMS_ALWAYS
  src/adapters/        telegram, textbelt, twilio, fcm (stub); one interface (types.ts)
  src/link.ts          Telegram chat-id linking (app-made 128-bit deep-link token, KV, 10-minute TTL, one-time)
  src/ratelimit.ts     best-effort per-IP token bucket (in-isolate)
  test/                vitest; every upstream call mocked; KV faked in memory
```

## Endpoints

### `POST /sos`

```json
{
  "to": { "phone": "+919876543210", "telegramChatId": "123456789", "pushToken": "…" },
  "message": "RAKSHA EMERGENCY - …",
  "channels": ["telegram", "textbelt"]
}
```

- `to` — at least one of `phone` (E.164), `telegramChatId`, `pushToken`.
  **Legacy form still accepted:** `{ "to": "+919876543210", "message": "…" }` — what the current
  app build sends — is treated as `to: { phone }` with the Worker's `CHANNEL_ORDER`.
- `message` — sent **verbatim**. The app composed and length-managed it; the relay never rewrites
  it. Max 4096 characters (Telegram's ceiling).
- `channels` — optional order. Unknown names are dropped; if none of the named channels is
  configured on this deployment, `CHANNEL_ORDER` applies instead.

Response:

```json
{ "results": [ { "channel": "telegram", "ok": true },
               { "channel": "textbelt", "ok": false, "error": "textbelt: Out of quota (quotaRemaining: 0)" } ],
  "delivered": true }
```

| HTTP | Meaning |
| --- | --- |
| `200` | `delivered: true` — at least one channel succeeded |
| `502` | `delivered: false` — every channel failed; the app falls back to the SMS composer |
| `400` | invalid body (`{ "error": "…" }`) |
| `401` | `RELAY_APP_KEY` is set and `X-PHC-Key` does not match |
| `429` | per-IP rate limit (in-isolate, best-effort — see below) |

| `503` | misconfigured deployment: a paid SMS channel is configured but `RELAY_APP_KEY` is not (fail closed) |
| `413` | body over 16 KiB |

Channel rules (`src/dispatch.ts`):

1. **Every planned channel gets one result row** — sent, failed, `not configured`,
   `contact has no …`, `skipped: already delivered` or `deadline exceeded`. Unconfigured and
   inapplicable channels cost nothing.
2. **Time budget.** The phone gives the whole call 10 s. Each adapter gets 3.5 s
   (`AbortSignal.timeout`) and the dispatch as a whole 8 s; an adapter that would start after the
   deadline is reported as `deadline exceeded` instead of running, and one still running at the
   deadline is abandoned with the same row — the relay never answers later than 8 s after it
   started, even if a provider ignores the abort.
3. With `SMS_ALWAYS=true` (the default) and a phone number on the contact, the SMS lane runs
   **concurrently** with the data lane (Telegram): a hung Telegram call cannot eat the SMS's time.
   Both lanes start together, so the SMS may reach the caregiver before the Telegram message does
   — plan order is a priority for reporting, not a sequence.
   Telegram reaching a phone does not mean the caregiver saw it; an SMS lights the lock screen. An
   emergency deserves both. Exactly one SMS adapter is attempted after a data success (Textbelt
   preferred, then Twilio — and if the request named only an unconfigured SMS adapter, the
   configured one is added); a second SMS adapter runs only while nothing at all has been
   delivered. Set `SMS_ALWAYS=false` to run the plan sequentially and stop at the first success.

### Telegram linking — `POST /link` and `POST /telegram/webhook`

A bot can only message a chat that opened it first, so a caregiver links once by **tapping a link**:

1. The **app** generates a 128-bit random `linkToken` (base64url, 22 characters — `crypto`
   randomness, never a counter) and shows the caregiver
   `https://t.me/<BOT_USERNAME>?start=<linkToken>` (QR later). `BOT_USERNAME` comes from `/health`.
2. The caregiver taps it; Telegram opens the bot and sends `/start <linkToken>` to
   `POST /telegram/webhook`. The Worker stores `link:<linkToken> → chat_id` in KV for ten minutes
   and replies: *"Linked to PHC. You will receive emergency alerts here."* Any other message,
   including a bare `/start`, gets a one-line help reply and stores nothing.
3. The app polls `POST /link { "linkToken": "…" }` → `404 { "error": "not linked yet, expired or
   already used" }` until the tap lands, then `200 { "telegramChatId": "123456789" }` **once** (the
   key is deleted). Gated by the app key and rate limit like `/sos`.

Why a token the app makes rather than a code the caregiver types: six digits are 10^6 guesses in a
ten-minute window, which per-IP limits do not make safe; 128 bits are not guessable in any window,
and the only party that ever sees the token is the caregiver's Telegram client. KV is eventually
consistent (up to ~60 s across locations), so "one-time" is exact where the delete happens and
best-effort elsewhere inside that window — the token is worthless once the app has the chat id.

The webhook **requires** `TELEGRAM_WEBHOOK_SECRET`: without it the route answers `503` (it never
runs unauthenticated), and with it the `X-Telegram-Bot-Api-Secret-Token` header must match (`401`).
It always answers `200` once authenticated so Telegram does not retry.

### `GET /health`

```json
{ "ok": true, "service": "phc-sos-relay",
  "channels": { "telegram": true, "textbelt": true, "twilio": false, "fcm": false },
  "channelOrder": ["telegram", "textbelt"], "smsAlways": true,
  "appKeyRequired": false, "appKeySet": false, "webhookSecured": true,
  "linking": true, "botUsername": "phc_bot" }
```

`appKeyRequired: true` with `appKeySet: false`, or `webhookSecured: false`, means the deployment is
misconfigured and the affected route answers `503`. Never includes a secret.

## Configuration

Non-secret vars live in `wrangler.toml` `[vars]`:

| Var | Default | Meaning |
| --- | --- | --- |
| `CHANNEL_ORDER` | `telegram,textbelt` | Order when the request names no channels (the legacy body). Remove `textbelt` here to switch off the free-tier SMS. |
| `SMS_ALWAYS` | `true` | Attempt one SMS after a Telegram success when a phone number exists. |
| `RATE_LIMIT_PER_MINUTE` | `10` | In-isolate token bucket per IP for `/sos` and `/link`. |
| `BOT_USERNAME` | `""` | The bot's public username (no `@`); exposed on `/health` for the app's deep link. |

Secrets (`wrangler secret put NAME`, never in the repo):

| Secret | Enables |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | `telegram` adapter + `/telegram/webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | **mandatory** for the webhook — the route answers `503` without it. The same value goes to `setWebhook` as `secret_token`. |
| `TEXTBELT_KEY` | paid Textbelt key; unset = `textbelt` free tier (1 SMS/day per egress IP) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | `twilio` adapter — all three or it stays `not configured` |
| `RELAY_APP_KEY` | `X-PHC-Key` check on `/sos` and `/link`. **Optional** for Telegram + free-tier Textbelt; **mandatory** once Twilio or a paid `TEXTBELT_KEY` is configured — `/sos` answers `503` otherwise, so a leaked URL can never spend money. Not a secret in the cryptographic sense (it ships inside the app bundle); it raises the bar, it does not authenticate the app. |

## Deploy runbook

Prerequisites: a Cloudflare account (free, no card) and a Telegram bot token from **@BotFather**
(`/newbot`, copy the token). Node 22.

```sh
cd relay
npm ci
npm run typecheck && npm test          # must be green before touching prod

npm i -g wrangler                      # or use the pinned local one via npx
wrangler login                         # opens the browser once

# 1. KV namespace for link tokens — paste the printed id into wrangler.toml [[kv_namespaces]] id;
#    also set BOT_USERNAME in [vars] to the bot's username from @BotFather (without the @)
npx wrangler kv namespace create LINKS

# 2. Secrets — each prompts for the value; nothing is written to disk in the repo
npx wrangler secret put TELEGRAM_BOT_TOKEN
WEBHOOK_SECRET="$(openssl rand -hex 32)"            # keep it in the shell for step 4
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # MANDATORY
npx wrangler secret put RELAY_APP_KEY                # optional for free channels; MANDATORY before
                                                     # TEXTBELT_KEY or TWILIO_* — same value in the app's env
# optional: TEXTBELT_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

# 3. Deploy — prints the workers.dev URL, e.g. https://phc-sos-relay.<account>.workers.dev
npx wrangler deploy
```

### Point the Telegram bot at the webhook (step 4)

Replace the placeholders; `secret_token` **must** equal `TELEGRAM_WEBHOOK_SECRET` — the webhook
answers `503` with no secret configured and `401` on a mismatch, so a forgotten step shows up on
the first `/start`, not silently.

```sh
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<WORKER_URL>/telegram/webhook" \
  -d "secret_token=$WEBHOOK_SECRET" \
  -d 'allowed_updates=["message"]'
# → {"ok":true,"result":true,"description":"Webhook was set"}
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Run these from a shell, not from the repo — the bot token must never land in a file here.

### Rate limiting that actually holds

`src/ratelimit.ts` is per-isolate memory: it stops a naive loop, not a distributed attacker. Add a
**Rate limiting rule** in the Cloudflare dashboard (free plan includes one):

*Security → WAF → Rate limiting rules → Create rule*
- If incoming requests match: `Hostname equals <WORKER_URL host>` **and** `URI Path is in {"/sos", "/link"}`
- With the same characteristics: `IP`
- When rate exceeds: `10` requests per `10 seconds` (the free-plan period)
- Then: `Block` for `10 seconds`

An emergency is one request per contact, once; a real user never sees this rule — with one caveat:
**CGNAT.** Indian mobile carriers put many subscribers behind one shared IPv4 address, so a per-IP
rule counts strangers together. Keep the threshold generous (tens per period, not units), prefer
counting on IPv6 where the carrier offers it, and rely on `RELAY_APP_KEY` plus the 503 fail-closed
rules for the paid channels rather than on the IP rule alone.
Also worth doing: a Twilio spend cap if Twilio is ever enabled, and — for a pilot cohort — a
destination allowlist (not implemented; see `docs/features/sos-relay.md`).

**Textbelt's free tier is per source IP** — the Worker's egress IP, which is shared with other
Cloudflare tenants. "One free SMS per day" may therefore be zero in practice on any given day.
Treat the free tier as a smoke-test convenience, not a channel; validation will tell.

### Smoke test

```sh
RELAY=https://<WORKER_URL>

curl -sS "$RELAY/health"
# → {"ok":true,"service":"phc-sos-relay","channels":{"telegram":true,"textbelt":true,"twilio":false,"fcm":false},...}

# Legacy body (what the current app sends). With no Telegram chat id this goes out over Textbelt
# — the free tier allows ONE per day, so use a number you can check.
curl -sS -i "$RELAY/sos" -H 'Content-Type: application/json' \
  -H 'X-PHC-Key: <RELAY_APP_KEY if set>' \
  -d '{"to":"+91XXXXXXXXXX","message":"PHC relay smoke test - please ignore"}'

# Telegram: make a token the way the app will (128-bit base64url), open the deep link on the second
# phone, tap Start, then redeem it:
TOKEN="$(openssl rand -base64 16 | tr '+/' '-_' | tr -d '=')"
echo "Open on the second phone: https://t.me/<BOT_USERNAME>?start=$TOKEN"
curl -sS "$RELAY/link" -H 'Content-Type: application/json' -H 'X-PHC-Key: …' -d "{\"linkToken\":\"$TOKEN\"}"
# → 404 until the tap lands, then {"telegramChatId":"…"} once; then
curl -sS -i "$RELAY/sos" -H 'Content-Type: application/json' -H 'X-PHC-Key: …' \
  -d '{"to":{"telegramChatId":"<id>"},"message":"PHC relay smoke test - please ignore","channels":["telegram"]}'
```

A `200` with `"delivered":true` **and** the message visible on the second phone is the validation
event — record it in `docs/PROJECT_STATUS.md` and flip the row in the status table above.

Then point the app at it: `EXPO_PUBLIC_SOS_RELAY_URL=https://<WORKER_URL>/sos` in `.env.local` (the
legacy `EXPO_PUBLIC_TWILIO_SOS_URL` name is still read for one release when it points at this
Worker — the rename landed with M5 part 1b, PR #22).

### Local development

```sh
cp .dev.vars.example .dev.vars   # gitignored; fill in what you have (the webhook needs the secret even locally)
npm run dev                      # wrangler dev on http://localhost:8787 with a local KV
npm run check                    # wrangler deploy --dry-run: bundles + validates wrangler.toml, no account needed
```

## Privacy and logging

The message and the destination are the only health-adjacent data that reach this Worker, exactly as
in the previous Twilio-only design. The code never logs a request body, a phone number or a chat id;
the only `console.*` call is the error *name* on an unhandled exception. Workers Logs / observability
is deliberately not enabled in `wrangler.toml`; if you enable it for debugging, remember that
Cloudflare will then retain request metadata (URL, status, timing — not bodies) for the retention
period.

Health language in bot replies: these are **emergency alerts** relayed on the user's behalf, never a
diagnosis, and the copy says so.
