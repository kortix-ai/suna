# MS Teams connector — Phase D scoping

> Goal §1: *Channels: **MS Teams** connector (Phase D of the channel epic).*
> Mirko AGI cycle 26, 2026-07-19. Status: SCOPING.
>
> Surprise finding: the Teams connector **backend is already built and mounted**
> (`/v1/webhooks/teams/*` routes live in `apps/api/src/index.ts:721-724`).
> This is NOT a "build from scratch" task — it's a **CLI surface + feature
> parity** task. This doc scopes what's done, what's missing, and the proposed
> first PR.

## What's already built (Teams backend — production-ready)

The `apps/api/src/channels/teams/` directory (22 files) mirrors the Slack
connector's architecture:

| Capability | Slack file | Teams file | Status |
|---|---|---|---|
| App entry | `slack/app.ts` | `teams/app.ts` | ✅ |
| OAuth + admin consent | `slack-oauth.ts` + `slack/auth-resume.ts` | `teams-oauth.ts` + `teams/auth-resume.ts` | ✅ |
| Webhook (Bot Framework activities) | `slack-webhook.ts` | `teams-webhook.ts` | ✅ |
| Manifest | `slack-manifest.ts` | `teams-manifest.ts` | ✅ |
| App package + catalog publish | — | `teams/app-package.ts` + `teams/catalog.ts` | ✅ (publishes to Teams app store via Graph API) |
| Dispatch (message → session) | `slack/dispatch.ts` | `teams/dispatch.ts` | ✅ |
| Turn (agent → channel reply) | `slack/turn.ts` | `teams/turn.ts` | ✅ |
| Commands (slash commands) | `slack/commands.ts` | `teams/commands.ts` | ✅ |
| Interactivity (buttons, menus) | `slack/interactivity.ts` | `teams/interactivity.ts` | ✅ |
| Cards / rich content | `slack/review-cards.ts` + `slack/mrkdwn.ts` | `teams/cards.ts` | ✅ (Teams-native Adaptive Cards) |
| Binding (channel→agent/model) | `slack/selection.ts` | `teams/binding.ts` (reuses Slack's `ChannelCtx`) | ✅ |
| Session management | `slack/session.ts` | `teams/session.ts` | ✅ |
| Identity (authed login bind) | `slack/identity.ts` + `slack/identity-routes.ts` | `teams/identity.ts` + `teams/identity-routes.ts` | ✅ |
| File proxy | `slack/file-proxy.ts` | `teams/file-proxy.ts` | ✅ |
| Review (change-request approval) | `slack/review.ts` | `teams/review.ts` | ✅ |
| Questions (clarification prompts) | `slack/questions.ts` | `teams/questions.ts` | ✅ |
| JWT auth (Bot Framework) | — | `teams/jwt.ts` | ✅ (Teams-specific) |
| Service URL caching | — | `teams-service-url.ts` | ✅ (Teams-specific) |

**Mounted in the API** (`apps/api/src/index.ts`):
- `POST /v1/webhooks/teams/messages` — Bot Framework activities
- `GET /v1/webhooks/teams/oauth/callback` — admin-consent + catalog publish
- `POST /v1/channels/teams/identity/bind` — authed login bind

## What's missing — the real Phase D gaps

### Gap 1: CLI surface (the blocker for self-hosters)

`apps/cli/src/commands/channels.ts` has **zero Teams references**. An operator
can `kortix channels connect` for Slack (prints a one-click OAuth link), but
there's no `kortix channels connect --teams` equivalent. Self-hosters and
enterprise customers cannot set up Teams without the CLI.

**This is the top priority.** The backend is ready; the operator-facing CLI
isn't. The first PR should add:
- `kortix channels status` — show Teams installation state (mirrors Slack
  status, hitting `/projects/:id/channels/teams/installation`)
- `kortix channels connect --teams` — print the Teams admin-consent URL
  (mirrors Slack's OAuth link, hitting `/v1/webhooks/teams/oauth`)
- `kortix channels disconnect --teams` — remove the Teams install
- `kortix channels manifest --teams` — print/download the Teams app manifest

### Gap 2: Feature parity (lower priority — backend works without these)

Slack files with no Teams equivalent:
- `slack/dedup.ts` — Teams has inline dedup in `dispatch.ts`/`session.ts`
  (functional, but not extracted — harder to test/maintain). Low priority.
- `slack/errors.ts` + `slack/start-error.ts` — Teams has `teams/util.ts` +
  inline error handling. Functional, less structured. Low priority.
- `slack/home.ts` — Slack home tab (no Teams equivalent — Teams has no home
  tab concept). N/A.
- `slack/model-gate.ts` — model entitlement gating. Teams may need this if
  enterprise customers want model restrictions per channel. Medium priority.
- `slack/participants.ts` — participant tracking. Teams may handle this
  differently via Bot Framework conversation members API. Needs investigation.
- `slack/review-cards.ts` — Teams uses `teams/cards.ts` (Adaptive Cards).
  Functional, different format. N/A.
- `slack/mrkdwn.ts` — Slack-specific markdown. Teams uses Markdown in cards.
  N/A (format difference, not a gap).

### Gap 3: Tests (parity)

Slack has `__tests__/` with 8+ test files (`unit-slack-oauth.test.ts`,
`unit-slack-classify-event.test.ts`, `unit-slack-commands.test.ts`, etc.).
Teams has **no `__tests__/` directory**. The connector is untested. Medium
priority — the backend is mounted and presumably works (it's in prod), but
regressions would be caught only in production.

## Proposed first PR

**`kortix channels` CLI surface for Teams** (Gap 1) — the blocker for
self-hosters/enterprise. Mirror the Slack CLI path in `channels.ts`:

1. Add a `--platform slack|teams` flag (default `slack` for backward compat)
   to `status`/`connect`/`disconnect`/`manifest`.
2. `channelsStatus` — hit `/projects/:id/channels/teams/installation` when
   `--platform teams`.
3. `channelsConnect` — print the Teams admin-consent URL (from
   `teams-oauth.ts`'s redirect logic) when `--platform teams`.
4. `channelsDisconnect` — call the Teams install-delete endpoint.
5. `channelsManifest` — print/download the Teams app manifest
   (`teams-app-manifest.json`).

This is a focused, ~200-line CLI PR that unblocks Teams for every self-hoster.
No backend changes (the API routes are already live).

## What I need from a human before the first PR

- **Confirm the `--platform` flag approach** vs. a separate `kortix channels
  teams connect` subcommand (flag is simpler + consistent with the existing
  `channels` surface; subcommand is more discoverable).
- **Confirm Teams is the next channel priority** (Telegram
  `telegram-webhook.ts` also exists — is that ahead or behind Teams in
  priority?).
- **Point at any Teams-specific setup docs** I should align the CLI help text
  with (I see `teams-app-manifest.json` but no Teams setup runbook — should I
  write one alongside the CLI PR?).

## Scope of this doc

Grounded entirely in the current codebase: `apps/api/src/channels/teams/`
(22 files), `apps/api/src/channels/slack/` (28 files, the reference),
`apps/api/src/channels/index.ts` (exports), `apps/api/src/index.ts:718-724`
(route mounting), `apps/cli/src/commands/channels.ts` (CLI surface). Every
file/capability verified to exist.
