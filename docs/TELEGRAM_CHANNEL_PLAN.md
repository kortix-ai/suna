# Telegram Channel — Implementation Plan

Telegram as an **optional** channel, following the Slack/Email channel + executor
pattern. One branch (`telegram-channel`), one PR, one commit per stage below.

## Acceptance criteria

1. Same channel/executor pattern as Slack (webhook → bindings → session; replies +
   agent tools through the executor).
2. **Bot token stays server-side** — never in sandbox env, opencode config, or CLI.
3. Basic **send / read / file** behavior covered by ke2e tests.
4. UI/docs present Telegram as an **optional channel**, not a launch blocker.

## What already exists (verified)

- `apps/api/src/channels/telegram-webhook.ts` — `POST /v1/webhooks/telegram/:projectId`;
  `x-telegram-bot-api-secret-token` constant-time verify (404 unconfigured / 401 bad);
  dedupe via `idempotencyKey telegram:<projectId>:<update_id>`; spawns a session
  (`source: 'telegram'`, chat metadata). Registered in `channels/index.ts` + `index.ts:665`.
- `install-store.ts` — `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` key constants +
  `loadTelegramWebhookSecretForProject` (encrypted `project_secrets`, per project).
- `'telegram'` in `SessionInvocationSource`; spec §13 documents CHN-8/CHN-9 for the
  inbound gate; `chat_*` tables are platform-generic.

## Gaps this PR closes (one stage = one commit)

### Stage 1 — Install/connect API (`feat(channels): telegram installation routes`)
`apps/api/src/channels/telegram-api.ts`: minimal Bot API client (`getMe`, `setWebhook`,
`deleteWebhook`, `sendMessage`, `sendDocument`, `getFile`, retry-on-transient like
`slack-api.ts`). Token is used ONLY here, server-side. r4-style routes:
- `GET  /:projectId/channels/telegram/installation` (read ACL) — status: connected, bot username, webhook set.
- `POST /:projectId/channels/telegram/connect` (manage ACL) — body `{ bot_token }`;
  server validates via `getMe`, mints a random `webhook_secret`, calls `setWebhook`
  (public API base + `/v1/webhooks/telegram/:projectId`, `secret_token`), persists both
  via install-store `saveTelegramInstall` (+ `chat_installs` row), reconciles executor connectors.
- `DELETE /:projectId/channels/telegram/installation` (manage ACL) — `deleteWebhook`, purge secrets + install row.
BYO-token only (BotFather) — no shared OAuth app, mirroring the Slack BYO mode.

### Stage 2 — Bindings, continuity + command menu (`feat(channels): telegram bindings + thread continuity`)
Also: register `setMyCommands` at connect time (`/start` welcome + link hint, `/help`,
`/new` reset conversation → fresh session) and handle them in the webhook; in groups,
respond only when @-mentioned or replied-to (bot username cached from `getMe`).
Replace the stub's hardcoded `agent_name: 'default'` / session-per-update:
- Resolve `chat_channel_bindings` (platform `telegram`, channelId = `String(chat.id)`) →
  agentName / opencodeModel / conversationPolicy, same fold Slack uses.
- `chat_threads` continuity: (platform `telegram`, workspaceId = bot id, threadId =
  `String(chat.id)`) → sessionId; first update claims atomically, follow-ups continue
  the session instead of spawning new ones (respecting conversationPolicy).
- Auto-register a binding row on first contact so the dashboard Bindings section lists it.

### Stage 3 — Executor connector: token-isolated tools (`feat(executor): kortix_telegram connector`)
- `executor/channels.ts`: `TELEGRAM_CHANNEL_CONNECTOR_SLUG = 'kortix_telegram'`; action
  catalog — `send_message`, `send_document`, `get_file`, `get_chat` (verb/risk/schema per
  Slack precedent). `channelApiBase('telegram')` → `https://api.telegram.org` with an env
  override (`KORTIX_TELEGRAM_API_BASE`) so e2e can point at a stub.
- **Auth**: Telegram puts the token in the URL path (`/bot<token>/method`) — resolved
  server-side in the gateway via a path-template credential (like Slack's `{channel}`
  templating), never returned to the caller. `db-deps.channelToken('telegram')` →
  `loadTelegramTokenForProject`. `channel-materialize.ts` synthesizes when installed.
- Sandbox env for telegram-originated turns: `TELEGRAM_CHAT_ID`, `TELEGRAM_MESSAGE_ID`,
  `TELEGRAM_USER_ID` — context only, **no token** (mirrors `buildSlackTurnEnv`).

### Stage 4 — Outbound relay, Telegram-native UX (`feat(channels): telegram reply relay`)
The **nicest UX Telegram can express**, not a lowest-common-denominator port:
- **Live status message**: immediately `sendMessage` a placeholder ("⏳ Working…"), then
  progressively `editMessageText` it with the evolving answer (≤1 edit/sec, respecting
  429 `retry_after`) — the Telegram-native equivalent of Slack's streaming plan UI.
- **Typing indicator loop** (`sendChatAction` every ~5s) while the turn runs.
- **Rich text**: agent markdown → Telegram HTML parse mode (safe subset; plain-text
  fallback on parse failure) — bold/italic/code/links render properly.
- **Reply threading** via `reply_parameters` to the triggering message; **smart chunking**
  at 4096 chars on paragraph boundaries for long answers.
- **Inline keyboard** on the final message: `Open in Kortix` URL button deep-linking to
  the session.

### Stage 4b — Approvals from Telegram (`feat(channels): telegram approval buttons`)
When a telegram-originated session pauses on a pending executor approval, post the
approval prompt with **inline Approve / Deny buttons** (`callback_query` → the same
`resolveApproval` endpoint the web inbox uses; `answerCallbackQuery` for the tap feedback;
message edits to show the outcome). Human-in-the-loop without leaving the chat.

### Stage 5 — Files (`feat(channels): telegram file receive/send`)
- Inbound: `message.document`/`photo` → `getFile` → server-side download (size cap +
  same SSRF-guard pattern as `slack/file-proxy.ts`) → surfaced to the session.
- Outbound: `send_document` executor action (stage 3 catalog) accepts sandbox file path
  via the same file-relay mechanism Slack upload uses.

### Stage 6 — Web UI (`feat(web): telegram channel row (optional)`)
`channels-view.tsx`: `TelegramChannelRow` following `SlackChannelRow`/`EmailChannelRow` —
status badge, connect Modal (token input + BotFather hint), disconnect via ConfirmDialog,
bindings section picks up telegram rows automatically. Labeled **Optional** (Badge), no
setup nagging anywhere.

### Stage 7 — CLI (`feat(cli): kortix channels telegram`)
`channels.ts`: `status` includes telegram; `connect --platform telegram --bot-token …`;
`disconnect`. Help text marks it optional.

### Stage 8 — e2e + spec + docs (`test(ke2e): telegram channel flows`)
- `tests/src/flows/channels.flow.ts`: CHN-2x flows — installation status ACL, connect
  (validates + sets webhook against `KORTIX_TELEGRAM_API_BASE` stub), disconnect,
  inbound signature gates (formalizing CHN-8/9), **send** (executor `send_message`
  against stub), **read** (inbound update → session spawn + continuity), **file**
  (`get_file`/`send_document` against stub).
- `tests/spec/end-to-end.md` §13 rows + route manifest regen (`dump-routes.ts`).
- Docs: channels doc mentions Telegram as optional; no launch-path references.

## Design decisions

- **BYO bot token only** (no shared Telegram app) — matches Telegram's model; simplest secure path.
- **Token-in-URL** handled by gateway-side path templating; the sandbox only ever sees
  the connector slug + action names.
- **No streaming UI** — Telegram has no Block Kit; replies are single messages (typing
  action for liveness). Keeps the relay dramatically simpler than Slack's.
- **e2e without real Telegram** — `KORTIX_TELEGRAM_API_BASE` override + local stub, so
  send/read/file are genuinely exercised (request shape asserted) with zero external calls.

## Sender pairing (allowlist)

Telegram bots are world-messageable, so the inbound webhook only runs agent turns for
senders on the project allowlist (`projects.metadata.telegram.allowedUserIds`, gate
`TELEGRAM_REQUIRE_USER_IDENTITY`, default ON / fail closed). Pairing is how humans get
on the list without hunting for their numeric Telegram id:

- Dashboard (Channels → Telegram → Pair) or `kortix channels pair` mints a single-use
  15-minute code (`POST /channels/telegram/pairing-code`; connect mints the first one).
- The user sends the bot `/start <code>` (deep link `t.me/<bot>?start=<code>` works) —
  the webhook constant-time-validates it, allowlists the sender, clears the code.
- Unpaired senders in private chats get one pairing hint (dedup-throttled), never a turn.
- Remove via the Pair modal (`DELETE /channels/telegram/allowed-users/:userId`).

Pure logic in `channels/telegram/pairing.ts` (+ unit tests); the paired sender still runs
as the project automation actor — pairing is authorization, not identity attribution.

## Out of scope (deliberate)

Slash-command UX (`/kortix` parity), group-admin flows, inline keyboards/interactivity,
per-user identity binding (`chat_user_identities` login flow — sessions attribute to the
project automation actor as today; the pairing allowlist above decides WHO may trigger
them), Slack-style streaming plan UI.
