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
    "origin_ref": "your-app-user-123",
    "agent_name": "support",
    "opencode_model": "anthropic/claude-opus-4-8",
    "connector_bindings": { "gmail": { "profile_id": "<profile-id>" } },
    "secrets": ["STRIPE_KEY"]
  }'
```

The `201` response echoes what was applied — `origin: "backend"`, `origin_ref`,
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
  origin_ref: 'your-app-user-123',
  agent_name: 'support',
  opencode_model: 'anthropic/claude-opus-4-8',
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
| `origin_ref` | The end-user this session acts for. Recorded on the session and surfaced to the sandbox as `KORTIX_ORIGIN_REF`. **Attribution only** — not an auth principal. | **backend only** |
| `secrets` | Narrow which project secrets (by identifier) this session's sandbox receives. | **backend only** |

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
   (`provider: 'pipedream'` is the exception — it needs an interactive OAuth
   connect flow and can't be minted headlessly.)

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
   All of these are gated by `project.connector.write` (editor-tier and up) — a
   dashboard API key rides that automatically.

> **All-or-nothing binding:** if a session's `connector_bindings` sets *any*
> alias, every *unbound* alias resolves to null for that session. Bind every
> connector the agent needs in the one call.

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

### origin_ref — attribution, not identity

`origin_ref` records *who* the session is for and hands the sandbox
`KORTIX_ORIGIN_REF`. It does **not** resolve that user's connectors or secrets by
itself — pass those explicitly (`connector_bindings`, `secrets`). It exists so
usage, logs, and the agent can be attributed to your end-user without Kortix ever
knowing them as a login.

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

## 5. Errors you may hit

| Status | Code | Meaning |
|---|---|---|
| `403` | `origin_override_forbidden` | A non-backend caller (a human web session, the in-sandbox agent token) tried to set `origin_ref` or `secrets`. Use an API key / service-account bearer. |
| `404` | `SECRET_IDENTIFIER_NOT_FOUND` | An allowlisted secret identifier doesn't exist in the project. |
| `409` | `SECRET_IDENTIFIER_KEY_COLLISION` | Two allowlisted identifiers resolve to the same env var — name only one. |
| `400` | `INVALID_SESSION_SECRETS` / `INVALID_SESSION_CONNECTOR_BINDINGS` | Malformed `secrets` / `connector_bindings`. |

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

See also the runnable, end-to-end version of this flow —
[`packages/sdk/examples/09-kaab-backend-wrapper.ts`](../packages/sdk/examples/09-kaab-backend-wrapper.ts)
— and the printable one-page guide next to it
(`packages/sdk/examples/KORTIX-AS-A-BACKEND.pdf`).
