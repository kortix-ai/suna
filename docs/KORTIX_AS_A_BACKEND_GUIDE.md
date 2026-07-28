# Drive Kortix as a Backend

Wrap **one** Kortix agent + repo as the backend for **many** of your end-users.
Your product holds a single Kortix credential; each session you start on behalf
of a user brings *that user's* connectors, model, context, and secrets **by
reference**. Your end-users never log in to Kortix.

> Mental model (like Stripe Connect / Twilio subaccounts): **Kortix
> authenticates your backend; your backend vouches for its end-user.**

---

## 1. Get a credential (once)

Create an **API key** in the dashboard: **Settings → Tokens → Create API key**.
The token is shown once — put it in your backend's environment as `KORTIX_API_KEY`.

- The API key (a `kortix_pat_…` token) rides **your** project role, so it can
  start sessions on any project you can — no extra setup, any plan.
- For CI / least-privilege machine identities, a **Service account** (Settings →
  Service accounts) works too, but it must be granted `project.session.start`
  via an IAM policy first (an enterprise feature). **Start with the API key.**

A session started with either token is recorded with `origin: "backend"`, which
is what unlocks the backend-only overrides below.

---

## 2. Start a session on behalf of a user

`POST /v1/projects/:projectId/sessions` with a `Bearer` API key:

```bash
curl -X POST https://api.kortix.com/v1/projects/<project-id>/sessions \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "initial_prompt": "Summarize my new signups",
    "end_user_ref": "your-app-user-123",
    "agent_name": "support",
    "opencode_model": "kortix/claude-opus-4.8",
    "connector_bindings": { "gmail": { "profile_id": "<profile-id>" } },
    "secrets": ["STRIPE_KEY"]
  }'
```

The `201` response echoes what was applied — `origin: "backend"`, `end_user_ref`,
`agent_name`, `secrets_allowlist` — so you can confirm it took effect.

### SDK

Use the server SDK entry (`@kortix/sdk/server`) — it carries your API key and
base URL explicitly, which the deprecated browser `projects-client` cannot do.
This is the same surface the runnable example uses.

```ts
import { createScopedKortix } from '@kortix/sdk/server';

const kortix = createScopedKortix({
  backendUrl: process.env.KORTIX_API_URL!, // base incl. /v1
  getToken: async () => process.env.KORTIX_API_KEY!, // your kortix_pat_ token
});

const session = await kortix.project(projectId).sessions.create({
  initial_prompt: 'Summarize my new signups',
  end_user_ref: 'your-app-user-123',
  agent_name: 'support',
  opencode_model: 'kortix/claude-opus-4.8',
  connector_bindings: { gmail: { profile_id } },
  secrets: ['STRIPE_KEY'],
});
```

### CLI

```bash
kortix sessions new --prompt "Summarize my new signups" \
  --origin-ref your-app-user-123 \
  --agent support --model anthropic/claude-opus-4-8 \
  --connector gmail=<profile-id> \
  --secret STRIPE_KEY
```

---

## 3. The overrides

Everything is **by reference** — you never send a raw credential or secret value
in the request. Anything you omit falls back to the project/agent default, so an
internal (no-override) call is byte-identical to a normal session.

| Field | What it does | Who may set it |
|---|---|---|
| `agent_name` | Which declared agent runs the session. | anyone |
| `opencode_model` | Pin the model for this session (`KORTIX_OPENCODE_MODEL`). | anyone |
| `runtime_context` | A small non-secret JSON envelope injected as `KORTIX_SESSION_CONTEXT`. | anyone |
| `connector_bindings` | Map a connector alias → a specific **connection profile** (your end-user's own connected account). The credential is resolved server-side at use time and **never enters the sandbox**. | project manager |
| `end_user_ref` | The end-user this session acts for. Recorded on the session and surfaced to the sandbox as `KORTIX_END_USER_REF`. **Attribution only** — not an auth principal. | **backend only** |
| `secrets` | Narrow which project secrets (by identifier) this session's sandbox receives. | **backend only** |

### Model — reference form & validation

`opencode_model` is validated at create and stored in the **opencode reference
form**. Use:

- **Managed Kortix models:** `kortix/<id>` (e.g. `kortix/claude-opus-4-8`). A
  bare id (`claude-opus-4-8`) is accepted and normalized to `kortix/<id>` for
  you — but always prefer the explicit `kortix/` prefix.
- **Bring-your-own-key models:** `<provider>/<id>` (e.g.
  `anthropic/claude-opus-4-8`, `openai/gpt-5`) — the provider segment is required.

A model that isn't servable for your account (retired, not entitled on your
plan, or a typo) is rejected at create with **`400 INVALID_SESSION_MODEL`** —
you get the error immediately, not a dead turn at prompt time. Omit
`opencode_model` to inherit the project/agent default.

### Idempotent retries — always send an `Idempotency-Key`

Session create provisions real compute, so a blind retry (timeout, dropped
connection) could double-create and double-charge. Send an **`Idempotency-Key`
header** (raw HTTP) so a retry with the same key returns the *original* session
instead of a new one.

```bash
# generate a UUID ONCE per logical create; reuse it across that create's retries
KEY=$(uuidgen)
curl -X POST .../sessions -H "Idempotency-Key: $KEY" …
```

The header is validated: 1–255 chars of `[A-Za-z0-9._:+/=-]` (spaces, unicode,
or an oversized value → `400 INVALID_IDEMPOTENCY_KEY`).

Rules that will bite if you ignore them:

- **Use a high-entropy key** (a UUID you generate per logical create, reused
  only across that create's retries). The key lives in a **globally** unique
  index, and a collision with a *different* account's or project's key is
  rejected as a conflict — so a low-entropy key like `"1"` or a guessable channel
  key can be squatted by (or collide with) another tenant. Pick something
  unguessable.
- **A replay with a *different* body conflicts.** Same key + different
  `connector_bindings` / `secrets` → **`409`** (`IDEMPOTENCY_BINDING_CONFLICT` /
  `IDEMPOTENCY_SECRETS_CONFLICT`). Keep the body identical across retries.
- **A failed create is terminal for that key.** If the original attempt failed,
  replaying the same key returns the failure — use a fresh key to genuinely
  retry a new create.

> The SDK's `sessions.create()` does not yet forward an idempotency key — send it
> via the raw HTTP form above when you need at-most-once create semantics.

### Connectors — bring each user's own account

Store a user's credential **once** via the connection-profile broker, get a
`profile_id` back, and pass it by reference in `connector_bindings`. Kortix
resolves the profile's credential **server-side** when the agent invokes the
connector — the secret never lands in the sandbox env, and one binding can't
reach another user's profile. This is how the same shared agent talks to *each*
user's Gmail/Slack/etc. without per-user Kortix logins.

**Creating a connector, fully from your backend** (no browser) — two layers,
both mintable with your API key:

1. **The connector definition** (project-wide) — what/where the connector is.
   For `provider` `mcp` / `http` / `openapi` / `graphql` (static credential, no
   OAuth) this is fully headless:
   ```ts
   await kortix.project(projectId).connectors.create({
     slug: 'user-mcp', provider: 'mcp', transport: 'http',
     url: 'https://mcp.example.com/mcp', credential: 'shared',
     auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer ' },
   });
   ```
   (`provider: 'pipedream'` — the OAuth-app path used for Gmail, Slack, Notion,
   etc. — is registered the same way, but **authorized** differently: there is no
   static token to store, so the end-user consents in their browser once. It's
   still per-end-user and fully API-driven — see *"OAuth apps"* just below.)

2. **A per-end-user connection profile** — the independent, by-reference layer.
   Use **`owner_type: 'external'`** so the profile belongs to *your app's user*,
   not a Kortix member or agent — that's what makes it usable purely by reference
   in a backend session:
   ```ts
   const profile = await kortix.project(projectId).connectors.profiles.reconcile({
     connector_alias: 'user-mcp', owner_type: 'external',
     owner_id: 'your-app-user-123', label: 'MCP for user 123',
   });
   await kortix.project(projectId).connectors.profiles.updateCredential(
     profile.profile_id, { value: usersOwnToken, kind: 'secret' });
   await kortix.project(projectId).connectors.profiles.activate(profile.profile_id);
   // → bind at session start: connector_bindings: { 'user-mcp': { profile_id: profile.profile_id } }
   ```
   All of these are gated by `project.connector_profiles.manage`, which is
   **manager-only** (`iam/role-perms.ts` `MANAGER_ONLY`) — the built-in
   **Manager** role, or owner/admin. An *editor* is NOT enough: `reconcile`
   returns 403 and `updateCredential` / `activate` return **404**, deliberately
   indistinguishable from "no such profile" so the endpoint never confirms a
   profile exists to someone who may not touch it. If you hunt a nonexistent id
   bug here, check the role first.

   Binding an `external` profile at session create additionally needs
   `project.session.bindings.write` — also manager-only. That is why the
   override table below says "project manager" for `connector_bindings`.

   **OAuth apps (Gmail, Slack, Notion — `provider: 'pipedream'`).** There's no
   static token to paste; the end-user authorizes in their browser **once**, and
   Kortix stores the connection by reference. Still per-end-user and fully
   API-driven — only the consent click is interactive (that's OAuth, not a Kortix
   limitation):
   ```ts
   // 1. mint this user's own external profile (non-default → connectable)
   const profile = await kortix.project(projectId).connectors.profiles.reconcile({
     connector_alias: 'gmail', owner_type: 'external',
     owner_id: 'your-app-user-123', label: 'Gmail for user 123',
   });
   // 2. get a connect link scoped to THIS user; send them to it
   const { connectUrl } = await kortix.project(projectId)
     .connectors.profiles.pipedreamConnect(profile.profile_id, {
       success_redirect_uri: 'https://yourapp.com/connected',
       error_redirect_uri: 'https://yourapp.com/connect-failed',
     });
   // → open connectUrl in the user's browser; they consent to Google/Slack/…
   // 3. after they return, finalize (binds their authorized account to the profile)
   await kortix.project(projectId).connectors.profiles.pipedreamFinalize(profile.profile_id);
   // → then bind by reference exactly like the static case:
   //   connector_bindings: { gmail: { profile_id: profile.profile_id } }
   ```
   Under the hood these are `POST …/connector-profiles/{profile_id}/connect` and
   `…/connect/finalize` — call them from any language, not just the SDK.

   > **Never `updateCredential` an OAuth (`pipedream`) profile.** It will store and
   > "activate" any string, but at run time that value is used as a **Pipedream
   > account id**, not a raw OAuth token — a pasted Google token silently fails on
   > the first tool call. Use `pipedreamConnect` + `pipedreamFinalize`; the OAuth
   > tokens live in Pipedream's custody, never in Kortix as a raw provider token.

**Picking a SPECIFIC connection.** One connector can hold several connections —
team-shared accounts (support@, sales@) and each member's own. List them to get
the id you want:

```bash
curl -sS "$KORTIX_API_URL/projects/$PROJECT_ID/connector-profiles" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  | jq '.profiles[] | {label, owner_type, is_default, profile_id}'
```

(The dashboard shows each connection's id on its row — **⋯ → Copy connection ID**.)
Then bind that id: `connector_bindings: { gmail: { profile_id: "<id>" } }`.

⚠️ **A backend can only bind TEAM connections.** A member's *private* connection
(`owner_type: "member"`) is bindable only by that member's own token — a service
account gets `404 CONNECTOR_PROFILE_NOT_FOUND` (deliberately identical to
not-found, so an id can't be used to probe who connected what). That is the point
of "private": it means *runs as me*, and a service account is not a person. If a
backend needs a particular mailbox, add it as a **team** connection.

Omit `connector_bindings` for an alias and it resolves the team **default** —
which is what the `Default` badge in the dashboard marks.

> **All-or-nothing binding:** if a session's `connector_bindings` sets *any*
> alias, every *unbound* alias resolves to null for that session. Bind every
> connector the agent needs in the one call — **or** pass **`inherit_unbound: true`**
> to keep the project-default fallback for the unbound aliases, so you can override
> just one connector (e.g. one end-user's own account) without re-binding the rest.
> `inherit_unbound` only ever inherits the project *default* — never another
> user's profile — so it is safe for any caller.

> **Revoked mid-session fails closed.** If an end-user disconnects their account
> (the profile goes `revoked`) while a session is live, the broker returns
> **null** for that connector — it never falls back to a shared project default.
> The agent's call to that connector fails; your wrapper should detect it and
> prompt the user to reconnect — re-run the profile's connect steps
> (`updateCredential` + `activate` for a static connector, or `pipedreamConnect` +
> `pipedreamFinalize` for an OAuth app), which mint a fresh active profile.

A complete, runnable version of this whole flow — create connector → mint the
per-user profile → start a backend session → **stream the answer** — lives at
[`packages/sdk/examples/09-kaab-backend-wrapper.ts`](../packages/sdk/examples/09-kaab-backend-wrapper.ts)
(one-shot CLI **and** a multi-tenant SSE service in one file).

### Secrets — narrow, never widen

`secrets` is a **pure narrowing**: the session's sandbox receives
`(the agent's secret grant) ∩ (your allowlist)`.

- `["STRIPE_KEY"]` → only `STRIPE_KEY` (of what the agent may already see).
- `[]` → **zero** project secrets.
- Omitted → the agent's normal set (unchanged from today).

It can **never widen** beyond what the agent is already granted: if the agent's
manifest grants it no secrets (or not that one), the allowlist can't add it back
— the session simply gets fewer. Identifiers are validated at create, so a typo
fails fast rather than silently injecting nothing.

### end_user_ref — a label, not a lever

`end_user_ref` records *which of your end-users* a session was started for. It is
an opaque string you choose; Kortix never resolves it to a login.

**Exactly what it does, today:**

1. **Stored + echoed** on the session (`end_user_ref` in every session response).
2. **Handed to the agent** as the `KORTIX_END_USER_REF` sandbox env var, so a
   prompt/tool can say who it is acting for. (Kortix itself never reads it back.)
3. **Guards idempotent retries.** Replaying an `Idempotency-Key` with a
   *different* `end_user_ref` is refused with `409 IDEMPOTENCY_ORIGIN_CONFLICT`, so
   a retry can never hand end-user B the session that belongs to end-user A. This
   is the one thing that would actually break without it.

**What it does NOT do — do not design around these:**

- **It grants nothing.** It is never an input to an authorization decision. The
  403 you may hit is about *who may set the field* (backend origin only), not
  about its value.
- **It resolves nothing.** It does not pull that user's connectors or secrets —
  pass those explicitly (`connector_bindings`, `secrets`).

**What it DOES drive — listing, metering and caps:**

```
GET /v1/projects/{projectId}/sessions?end_user_ref=user-123
```

Returns only the sessions started for that end-user, filtered server-side — you
do not have to pull the whole project and filter yourself, and the response never
contains another end-user's rows. It spans every status, so finished sessions
come back too. In the SDK:

```ts
await kortix.project(projectId).sessions.list({ end_user_ref: 'user-123' });
```

The deprecated `?origin_ref=` spelling works too. Sending both with *different*
values is refused (`400 END_USER_REF_CONFLICT`) rather than one silently winning;
sending both with the same value is fine. A blank handle is a `400`, not
"list everything".

**Metering and caps:**

```
GET /v1/usage?end_user_ref=user-123     # that end-user's spend (totals + breakdown)
GET /v1/usage?group_by=end_user_ref     # spend per end-user, biggest first
```

Usage events carry a server-derived copy of `end_user_ref`, so per-end-user spend
is a real query. Two caveats worth knowing:

- **Only backend-session spend is attributed.** Rows written before this shipped,
  the model playground, and the legacy router path all have a `NULL` `end_user_ref`
  and are *excluded* from `group_by=end_user_ref` — they aren't folded into an
  anonymous bucket that would read as a phantom end-user. The unfiltered totals
  in `data` still include them, so per-user rows won't sum to the account total.
- **The value lands in the billing ledger and comes back out of the API**, so use
  an opaque id — not an email.

For **spend**, `KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD` refuses a session
create for an end-user who has already spent that much inside
`KORTIX_BACKEND_PER_END_USER_SPEND_WINDOW_DAYS` (default 30). Unset/0 = off.
Exceeding it returns `429 per_end_user_spend_limit`, whose body carries
`spent_usd`, `limit_usd` and `window_days` so you can tell your user *why*.
Without it, the only backstop is the account balance — which fires once the
WHOLE wrapper is out of money, i.e. after one runaway end-user has already spent
everyone else's budget.

Two honest limits, the same ones the concurrency cap has: it is **check-then-act**
(N parallel creates for one end-user can each see the same under-limit total, so
it is a runaway guardrail, not a hard quota), and it is measured at session
**create** — a session already running is not killed mid-turn when it crosses the
line; the next create is what gets refused.

For concurrency, `KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT` caps how many LIVE
sessions one end-user may hold (0/unset = off; the account-wide cap always
applies). Exceeding it returns `429 per_origin_session_limit`. It's a check-then-
act guard, like the account cap — N parallel creates for one end-user can still
overshoot slightly, so treat it as a runaway-loop guardrail, not a hard quota.

Treat `end_user_ref` as a durable label for correlation, attribution and metering.
If you need structured per-user context inside the run as well, put it in
`runtime_context`.

---

## 4. Stream the answer

```ts
const s = kortix.session(projectId, session.session_id);
await s.ensureReady();               // blocks through the sandbox cold start
const h = await s.stream({ onEvent: (e) => {
  const ev = narrowChatEvent(e);
  if (ev?.type === 'message.part.updated' && ev.part.type === 'text')
    process.stdout.write(ev.part.text);
  if (ev?.type === 'session.idle') h.close();
} });
await s.send(prompt);
```

- **`ensureReady()` polls the cold start.** A fresh sandbox can take tens of
  seconds to boot OpenCode; `ensureReady()` long-polls until the runtime is ready
  (default ~3 min) and only then resolves, so `stream()` connects before the
  prompt goes out. Pass `{ readyTimeoutMs }` to wait longer.
- **Streaming needs the sandbox to reach *your* API.** The sandbox finishes
  booting by calling back to its `KORTIX_URL`. A hosted deployment satisfies this
  automatically. Against a **local** API a cloud sandbox can't reach `localhost`,
  so front it with a public tunnel and start the API with that URL, e.g.:
  ```bash
  cloudflared tunnel --url http://localhost:8010    # → https://<name>.trycloudflare.com
  KORTIX_URL=https://<name>.trycloudflare.com PORT=8010 pnpm --filter @kortix/api start
  ```

---

> **Pick one prompt path.** A session created *with* `initial_prompt` runs that
> prompt automatically. If you then also `send()` a prompt (as the streaming
> snippet does), that's a **second turn** — and a second charge. For the
> stream-and-drive pattern above, create the session **without** `initial_prompt`
> and let `send()` deliver the first turn (this is what
> [`examples/09`](../packages/sdk/examples/09-kaab-backend-wrapper.ts) does).

> **Visibility & resume.** Backend-origin sessions default to
> `visibility: private`, and the connectors/secrets a session resolves are
> **locked to the session at creation** — resuming or viewing a session never
> re-resolves against the *current* actor's profiles. So a teammate (or your own
> admin) opening a backend session can't cause it to act with *their* Gmail/etc.
> Stream to your end-user by **relaying the server-side SSE** (as example 09
> does) — that is the supported browser path today; there is no per-session
> browser token yet.

## 5. Errors you may hit

| Status | Code | Meaning |
|---|---|---|
| `403` | `origin_override_forbidden` | A non-backend caller (a human web session, the in-sandbox agent token) tried to set `end_user_ref` or `secrets`. Use an API key / service-account bearer. |
| `404` | `SECRET_IDENTIFIER_NOT_FOUND` | An allowlisted secret identifier doesn't exist in the project. |
| `409` | `SECRET_IDENTIFIER_KEY_COLLISION` | Two allowlisted identifiers resolve to the same env var — name only one. |
| `409` | `IDEMPOTENCY_SECRETS_CONFLICT` / `IDEMPOTENCY_BINDING_CONFLICT` | An `Idempotency-Key` was replayed with a different `secrets` / `connector_bindings` body. Keep the body identical across retries. |
| `400` | `INVALID_SESSION_MODEL` | `opencode_model` isn't servable for this account (retired, not entitled, or a typo), or isn't a valid model id. |
| `400` | `INVALID_SESSION_SECRETS` / `INVALID_SESSION_CONNECTOR_BINDINGS` / `INVALID_SESSION_RUNTIME_CONTEXT` | Malformed `secrets` / `connector_bindings` / `runtime_context` (the last also rejects credential-like keys and enforces the 64-entry / 16 KiB caps). |
| `403` | `CONNECTOR_NOT_ASSIGNED` | The session's agent isn't granted a connector you named in `connector_bindings` (or `require_connectors`). **The first error most wrappers hit** — any project with an `agents:` block must list the alias under that agent's `connectors:`. |
| `403` | `REQUIRE_CONNECTORS_INTERACTIVE_ONLY` | A backend caller used `require_connectors`. A wrapper key acts for no single person, so "the current user's own connection" has no meaning — bind an explicit `profile_id` with `connector_bindings` instead. |
| `409` | `CONNECTOR_CONNECTION_REQUIRED` | Interactive only: this user hasn't connected their own account for a required connector. The body names `connector` so you can prompt for exactly that one. |
| `409` | `CONNECTOR_PROFILE_INACTIVE` | The bound connection is revoked or errored. Reconnect it; a revoked profile fails closed and never silently falls back. |
| `409` | `IDEMPOTENCY_ORIGIN_CONFLICT` | An `Idempotency-Key` was replayed under a **different** `end_user_ref`. This is the guard that stops one end-user receiving another's session — do not work around it by reusing keys. |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | The key collided with a different operation. Remediation is the **opposite** of the other idempotency errors: use a higher-entropy key. The uniqueness index is global. |
| `409` | `END_USER_REF_CONFLICT` | You sent both `end_user_ref` and the deprecated `origin_ref` with **different** values. Send only `end_user_ref`. |
| `409` | `SESSION_NOT_RUNNING` | You tried to change the model of a terminal session. Nothing would consume it. |
| `429` | `concurrent_session_limit` / `per_origin_session_limit` | Account-wide, or per-end-user when `KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT` is set (defaults to 0 = off). Retry with backoff. |
| `402` | `subscription_required` / `insufficient_credits` | Billing. Not retryable without operator action. |

---

## 6. Security model (why it's safe)

- **Origin is derived, never declared.** The session's `origin` comes from your
  token kind, not the request body — a caller can't claim `backend` to unlock
  backend-only fields.
- **The in-sandbox token is not a backend.** The token injected into every
  sandbox (and any agent-scoped token) resolves to `origin: user`, so a
  prompt-injected agent can't start a session that vouches for a phantom user or
  widens secrets.
- **Nothing widens.** `secrets` only narrows within the agent's grant;
  `connector_bindings` credentials are broker-resolved server-side and never
  enter the sandbox.
- **A session's token dies with its sandbox.** The executor token injected into a
  sandbox is revoked when the session is deleted or the provider reports the box
  removed — so an exfiltrated token stops working instead of outliving the
  session that justified it. An *idle stop* deliberately does not revoke: the box
  can be woken and is still the same container, holding the same token.

See also the runnable, end-to-end version of this flow —
[`packages/sdk/examples/09-kaab-backend-wrapper.ts`](../packages/sdk/examples/09-kaab-backend-wrapper.ts)
— and the printable one-page guide next to it
(`packages/sdk/examples/KORTIX-AS-A-BACKEND.pdf`).


## A note on the name

`end_user_ref` was called `origin_ref` until 2026-07-27. The old name read as
"a reference to the origin" (which app) when it means "a reference within the
origin" (which of your users) — and that ambiguity invited callers to put a
request id or a tenant there, producing a usage breakdown that looks right and
bills nobody.

`origin_ref` is still accepted everywhere and always will be: it is a published
wire field. Sending both is fine when they agree; disagreeing values are
rejected `400 END_USER_REF_CONFLICT` rather than one silently winning. Sandboxes
receive both `KORTIX_END_USER_REF` and `KORTIX_ORIGIN_REF`. The database column
keeps its original name — that is internal and renaming it would buy nothing.

## Changing a running session's model

`opencode_model` is set at create, but a live session can be re-pointed:

```bash
curl -sS -X PUT "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$SESSION_ID/model" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"opencode_model":"kortix/claude-opus-4.8"}'
```

```jsonc
{ "opencode_model": "kortix/claude-opus-4.8", "applied_live": true }
```

Three things worth knowing:

- **`applied_live` is not decoration.** `true` means a running sandbox took it
  now; `false` means it was stored and applies when the session next starts.
  Report the difference to your user — someone told "model changed" whose next
  answer comes from the old model has been misled.
- **Applying it live restarts the runtime**, which ends the in-flight turn. A
  no-op PUT (same model) deliberately does *not* restart, so re-sending is free.
- Only the session owner or a project manager may change it. Being able to *see*
  a shared session is not permission to re-point it.

The model is validated against the same servability check as create, so an
unentitled or retired id fails fast with `400 INVALID_SESSION_MODEL` rather than
becoming a dead turn later.

## Per-connection permissions

One connector can hold several connections — `support@`, `sales@`, a member's
own mailbox — and they often warrant different permissions. Policy resolves in
this order:

```
project rules   → un-overridable (the admin guardrail)
connection      → beats the connector default
connector       → the fallback
risk default    → read runs, write/destructive asks
```

So `support@` can be read-only while `sales@` may send, under one `gmail`
connector. Set it in the dashboard: **Connections → ⋯ → Permissions for this
connection**. A connector with no connection-level rule behaves exactly as
before.

## What a wrapper CANNOT change mid-session

| Override | Mid-session | Why |
| --- | --- | --- |
| `opencode_model` | **yes** — see above | |
| `agent_name` | **per message** — each prompt names the agent that runs it | A switch to an agent with a *different secrets grant* is refused `409 AGENT_SWITCH_REQUIRES_NEW_SESSION`; retrying cannot succeed, because re-scoping cannot un-read what the session already loaded. |
| `secrets` | **no** | `secrets_allowlist` is written once at create. A mutable allowlist could be narrowed below what the sandbox already needs and leave it unbootable. |
| `connector_bindings` | **no** | Create-only. Start a new session to bind differently. |
| `runtime_context` | **no** | Create-only. |
| `end_user_ref` | **no** | Create-only, and it is what usage attribution keys on. |

**A mid-session agent switch is governed, and the two halves are governed
differently — on purpose.**

- **Connectors and Kortix CLI actions are re-minted.** The switched-to agent's
  own grant is written onto the session token before the prompt runs, so it
  reaches exactly the connectors its manifest entry declares. These gates read
  the token at *call* time, so re-pointing it re-scopes every subsequent call.
- **Secrets refuse the switch** (`409 AGENT_SWITCH_REQUIRES_NEW_SESSION`) when
  the two agents declare different `secrets`. There is nothing to re-scope: by
  the time the switch is visible, the first agent's secrets are already in the
  sandbox's env file, in every shell it spawned, and in its own context.
  Narrowing later cannot un-read them. Agents with the *same* secrets grant
  switch freely.

If the re-mint cannot be applied, the prompt is refused with
`503 AGENT_SWITCH_GRANT_UNAPPLIED` rather than run under the previous agent's
authority. Operators who want *any* agent change refused, regardless of grants,
can still set `KORTIX_ENFORCE_SESSION_AGENT_LOCK=1`.

## Session isolation between your end-users

Sessions your backend creates all share one `created_by` — your wrapper
credential — so ownership alone cannot separate them. The platform narrows on
the *caller's* session instead: a token bound to end-user A's sandbox cannot
read, share, or resolve approvals on end-user B's session, even though both were
created by you.

Your backend credential is unaffected: it is the operator and still sees every
session it created. That asymmetry is deliberate.

Two consequences for wrapper authors:

- **`end_user_ref` must be injected server-side**, from your authenticated
  session — never accepted from a browser. A client that can set it can bill
  another user, or replay their session through a shared `Idempotency-Key`.
- Listing with `?scope=project` shows rows the caller cannot open, marked
  `can_access: false`. Those rows are **redacted**: no `metadata` (which holds
  `initial_prompt`), no `end_user_ref`, no `secrets_allowlist`.
