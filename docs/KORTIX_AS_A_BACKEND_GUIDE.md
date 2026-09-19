# Drive Kortix as a Backend

Use a Kortix API key to create and manage project sessions from your server.

> **Runtime scope.** The public `opencode_model` name remains unchanged for
> compatibility. Every session runs OpenCode over its REST compatibility
> interface. Prefer `useSession()` in React over the framework-free
> `session.stream()` / `session.send()` examples below.

Each session has one Kortix owner. Each session also has one project and one
unified cost record.

Your application owns customer identifiers and customer metadata. Store the
relationship between your customer and the returned `session_id` outside
Kortix.

## 1. Create a backend credential

Create one of these credentials:

- a personal access token
- a service-account bearer

The API derives `origin: "backend"` from either credential. The request body
cannot select the origin.

Use a service account when you need an independently managed principal. Grant
that principal the required project actions before use.

```bash
export KORTIX_API_URL="https://dev-api.kortix.com/v1"
export KORTIX_API_KEY="kortix_pat_..."
export KORTIX_PROJECT_ID="..."
```

## 2. Create a session

```bash
curl -sS -X POST \
  "$KORTIX_API_URL/projects/$KORTIX_PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "agent_name": "support",
    "opencode_model": "kortix/glm-5.3-flash",
    "runtime_context": {
      "ticket_id": "ticket-123"
    },
    "connector_bindings": {
      "gmail-read": {
        "connection_id": "00000000-0000-4000-8000-000000000000"
      }
    },
    "secrets": ["STRIPE_KEY"]
  }'
```

The `201` response contains the new `session_id`. Persist that identifier in
your application.

The later shell examples use this variable:

```bash
export SESSION_ID="<session-id>"
```

### SDK

```ts
import { createScopedKortix } from "@kortix/sdk/server";

const kortix = createScopedKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_API_KEY!,
});

const session = await kortix.project(projectId).sessions.create({
  agent_name: "support",
  opencode_model: "kortix/glm-5.3-flash",
  runtime_context: { ticket_id: "ticket-123" },
  connector_bindings: {
    "gmail-read": { connection_id: connectionId },
  },
  secrets: ["STRIPE_KEY"],
});
```

`createScopedKortix` isolates the token and runtime state for one server
request. Do not use a process-global active runtime in a multi-tenant server.

### Session-create fields

| Field                | Contract                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `agent_name`         | Selects a declared logical agent.                                                              |
| `opencode_model`     | Selects the initial model. The API validates availability before create.                       |
| `runtime_context`    | Stores non-secret scalar context.                                                              |
| `connector_bindings` | Selects one connection for each connector.                                          |
| `inherit_unbound`    | Keeps default connection resolution for unbound connectors. The default is `false`. |
| `secrets`            | Narrows the selected agent's project-secret grant. Only a backend-origin caller can set it.    |
| `require_connectors` | **Deprecated. Accepted, then ignored.** A session is never refused at create time for a connector with no usable account — see [Accounts and the call-time gate](#connector-accounts-and-the-call-time-gate). |

`runtime_context` accepts at most 64 scalar entries and 16 KiB. The API rejects
credential-like keys.

The wire field remains `opencode_model` for OpenCode compatibility.

## 3. Connectors

A connector is an agent-facing permission package for one provider
app: a declared capability, not an identity. It contains:

- a project-unique slug
- a display name
- a provider configuration
- a provider app reference
- connector policies

A connection is one **account** — one connected credential or authorization —
for a connector. A connector can hold several accounts side by side. Every
account under one connector uses the connector's policies. Create two
connectors when the same provider app needs two policy sets.

```yaml
connectors:
  - slug: gmail-read
    name: Gmail read only
    provider: pipedream
    app: gmail
    policies:
      - match: search_email
        action: always_run
      - match: "*"
        action: block

agents:
  support:
    connectors: [gmail-read]
```

### Account ownership (`owner_type`)

Each connection's `owner_type` is exactly one of:

- `project` — a **shared** account. Reachable by anyone the connector is
  granted to: a human member or a service account (agent, trigger).
- `member` — a **private** account, owned by one project member
  (`owner_id`). Reachable only by that member, and only in a **private**
  session. A service account can never run as a member's private account —
  there is no person behind a service-account call for the account to belong
  to.

A call that names no account resolves to the caller's own default private
account first, then the project's default shared account.

> **Deprecated: `authorization_strategy` (`project` | `user`).** It was a
> connector-level MODE that made project-owned and member-owned connections
> mutually exclusive per connector: a `project` connector accepted only
> project connections, a `user` connector accepted only the acting member's
> own connection, and a service account (no member identity) could use only
> `project` connectors. That mode was the direct cause of the incident this
> section documents the fix for: a `user`-strategy connector had no shared
> account to offer, so it had no connect flow a service account, a
> session-create pre-flight, or a channel could ever use — the old refusal
> below had no remedy that actually existed on the product. The manifest and
> `PUT .../authorization-strategy` still accept the field; the server ignores
> it. `owner_type` on each connection is the whole access rule now, and it is
> no longer mutually exclusive with anything: one connector can hold a
> `project` account and several `member` accounts at once.

The server enforces `owner_type` during:

- default connection resolution
- explicit binding (`connector_bindings`)
- an explicitly named account (`--account`, `account` on a call)
- connector execution

### Create a project connection

```ts
const projectHandle = kortix.project(projectId);

const connection = await projectHandle.connectors.connections.reconcile({
  connector_alias: "gmail-read",
  owner_type: "project",
  label: "Support inbox",
});

await projectHandle.connectors.connections.updateCredential(
  connection.connection_id,
  { value: credential, kind: "secret" },
);

await projectHandle.connectors.connections.activate(
  connection.connection_id,
);
```

The connection response and new binding input use `connection_id`.
The SDK accepts `authorization_id` as a deprecated input alias.

For Pipedream OAuth:

```ts
const { connectUrl } =
  await projectHandle.connectors.connections.pipedreamConnect(
    connection.connection_id,
    {
      success_redirect_uri: "https://example.com/connected",
      error_redirect_uri: "https://example.com/connect-failed",
    },
  );

await projectHandle.connectors.connections.pipedreamFinalize(
  connection.connection_id,
);
```

Do not pass an OAuth provider token to `updateCredential()`.

Create a **private** account for one member instead by setting `owner_type:
"member"` and its `owner_id`:

```ts
const mine = await projectHandle.connectors.connections.reconcile({
  connector_alias: "gmail-read",
  owner_type: "member",
  owner_id: callingUserId,
  label: "My Gmail",
});
```

A `member` account is reachable only by `owner_id`, only in a private session,
and never by a service account. The rest of the create/credential/activate
flow is identical for both owner types.

### Connector accounts and the call-time gate

`connectors_required` and `require_connectors` are **deprecated and inert.**
Declaring them still validates (each entry must exist in `connectors`), but
nothing reads the result any more: a session is never refused at create time,
rescope, or prompt admission for a connector with no usable account. That
pre-flight used to return `409 CONNECTOR_CONNECTION_REQUIRED` /
`409 REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` before sandbox startup — it
was the direct cause of the incident this section replaces: a `user`-strategy
connector had no shared account for the pre-flight to point at, so the
refusal had no remedy the caller could act on, and the agent's turn silently
never ran. Neither code can be returned by create, rescope, or prompt
admission any more. `packages/api-contract` keeps both schemas on the wire —
an old client parsing the shape does not break — but the server never emits
them.

The gate moved to the connector **call**, where a real remedy exists. List the
accounts a connector can be called as, default first:

```bash
curl -sS \
  "$KORTIX_API_URL/connectors/projects/$KORTIX_PROJECT_ID/connectors/gmail-read/accounts" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

```json
{
  "connector": "gmail-read",
  "accounts": [
    { "connection_id": "...", "label": "Support inbox", "owner_type": "project", "is_default": true },
    { "connection_id": "...", "label": "My Gmail", "owner_type": "member", "is_default": false }
  ]
}
```

Name one on a call — by connection id, by label (case-insensitive), or with
the selector words `me` (the caller's own default private account) or
`project` (the project's default shared account):

```bash
curl -sS -X POST \
  "$KORTIX_API_URL/connectors/projects/$KORTIX_PROJECT_ID/call" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connector":"gmail-read","action":"search_email","args":{},"account":"me"}'
```

Omit `account`, and the call resolves the caller's own default private account
first, then the project's default shared account — the same default a bound
connector resolved to before it could hold more than one account. A named
account that does not resolve is **denied**, never silently substituted:

```json
{
  "ok": false,
  "status": "denied",
  "reason": "connector_not_connected",
  "connector": "gmail-read",
  "requested_account": "nope",
  "available_accounts": ["Support inbox", "My Gmail"],
  "hint": "Connector \"gmail-read\" has no account named \"nope\". Available: \"Support inbox\", \"My Gmail\". Retry with one of those, or omit `account` for the default."
}
```

When nothing is connected at all, the same `reason` carries `connect_url`
instead — a hosted authorization link, whenever one can be minted for the
caller — which is the whole remedy for an unconnected connector now: the
agent surfaces the link verbatim, and the web transcript renders it as a
one-click Connect button. The link authorizes a **private** account for
whoever opens it by default; minting a link for the **shared** account is an
explicit choice that needs `project.connector.write`.

Every successful call also echoes which account it ran as:
`"account": { "connection_id": "...", "label": "Support inbox", "owner_type": "project" }`
— so the transcript always shows the identity a tool call used, not just that
it succeeded.

`403 CONNECTOR_NOT_ASSIGNED` is unrelated to accounts: it means the running
agent is not granted the connector at all in `kortix.yaml`. That is a manifest
fault, and connecting an account never clears it.

Stop (`POST .../prompts/hold {"held":true}`) immediately exposes every pending
or claimed prompt as `waiting` with reason `held`. Reload preserves that state.
The worker checks the persisted hold before each delivery attempt. Resume
clears the hold; Stop does not discard the prompt.

## 4. Secret scope

The `secrets` field narrows the selected agent's project-secret grant.

```json
{
  "secrets": ["DATABASE_URL"]
}
```

An empty list delivers no project secrets. A missing field uses the agent's
declared grant.

The API validates each identifier at create time. An unknown identifier returns
`404 SECRET_IDENTIFIER_NOT_FOUND`.

Secret scope cannot grant an identifier outside the selected agent's grant.

## 5. Read and replace session scope

Read the authoritative scope:

```bash
curl -sS \
  "$KORTIX_API_URL/projects/$KORTIX_PROJECT_ID/sessions/$SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

The response contains:

- `secrets_allowlist`, where `null` means the agent grant applies
- materialized `connector_bindings`
- added and dropped values
- `retroactive`
- `detail`

Each connector binding returns `connection_id`.

Replace scope:

```bash
curl -sS -X PUT \
  "$KORTIX_API_URL/projects/$KORTIX_PROJECT_ID/sessions/$SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "secrets": ["DATABASE_URL"],
    "connector_bindings": {
      "gmail-read": {
        "connection_id": "00000000-0000-4000-8000-000000000000"
      }
    }
  }'
```

The SDK exposes the same contract:

```ts
const handle = kortix.session(projectId, sessionId);
const current = await handle.scope();

const next = await handle.rescope({
  secrets: ["DATABASE_URL"],
  connector_bindings: {
    "gmail-read": { connection_id: connectionId },
  },
});
```

Each supplied field uses set semantics. The supplied value replaces the complete
previous value. Omit a field to leave it unchanged.

Connection changes apply to the next tool call. Secret removal
stops future delivery. It cannot remove a value from an existing model context
or process.

## 6. Read session costs

Every session has one cost record. The record combines finalized LLM cost and
billed sandbox compute cost.

List costs:

```bash
curl -sS \
  "$KORTIX_API_URL/usage/session-costs?project_id=$KORTIX_PROJECT_ID&limit=25&offset=0" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

Read one detail record:

```bash
curl -sS \
  "$KORTIX_API_URL/usage/session-costs/$SESSION_ID?project_id=$KORTIX_PROJECT_ID" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

The list returns:

- session and project identity
- session owner identity
- session status and timestamps
- LLM, compute, and total cost
- request and error counts
- token totals
- model count
- compute duration
- a reconciliation total for account usage without a session

The detail response adds `model_usage` and `ledger_entries`.

Ledger entries use `kind: "llm"` or `kind: "compute"`.

The SDK exposes three read paths:

```ts
const page = await kortix.billing.sessionCosts.list({
  accountId,
  projectId,
  limit: 25,
  offset: 0,
});

const detail = await kortix.billing.sessionCosts.get(sessionId, {
  accountId,
  projectId,
});

const sameDetail = await kortix.session(projectId, sessionId).cost();
```

`session.cost()` does not start the runtime.

## 7. Stream the session

```ts
const handle = kortix.session(projectId, session.session_id);
await handle.ensureReady();

const stream = await handle.stream({
  onEvent: (event) => {
    persistEvent(event);
  },
});

await handle.send("Summarize the support queue.");
```

`stream()` and `send()` use OpenCode REST. Use
`useSession(projectId, sessionId)` for a React host.

## 8. Idempotency

Generate one `Idempotency-Key` for each logical session-create operation.

Reuse the key only with an identical request body.

The same key and body return the same session. A changed secret allowlist,
connector binding map, or runtime context returns `409`.

An idempotency key longer than 255 characters returns
`400 INVALID_IDEMPOTENCY_KEY`.

## 9. Error reference

| Status                       | Code                                             | Meaning                                                                 |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `400`                        | `INVALID_SESSION_MODEL`                          | The selected model is unavailable.                                      |
| `400`                        | `INVALID_SESSION_CONNECTOR_BINDINGS`             | The connector binding map is malformed.                                 |
| `400`                        | `INVALID_SESSION_RUNTIME_CONTEXT`                | Runtime context violates its contract.                                  |
| `400`                        | `INVALID_IDEMPOTENCY_KEY`                        | The idempotency key exceeds 255 characters.                             |
| `403`                        | `origin_override_forbidden`                      | A non-backend caller supplied a secret allowlist.                       |
| `403`                        | `CONNECTOR_NOT_ASSIGNED`                         | The selected agent is not granted the connector.                |
| `404` create / `403` rescope | `CONNECTOR_CONNECTION_NOT_FOUND`                    | The connection is absent, or its `owner_type` is not reachable by this caller/session. |
| `404`                        | `SECRET_IDENTIFIER_NOT_FOUND`                    | The secret allowlist names an unknown identifier.                       |
| `409`                        | `CONNECTOR_PROVIDER_UNSUPPORTED`                 | The alias is a connector on the project but its provider has no hosted authorization page, so no connect link exists for it. |
| `409`                        | `CONNECTOR_PIPEDREAM_APP_MISSING`                | The Pipedream connector names no app, so no connect link can be built.  |
| `409` create / `403` rescope | `CONNECTOR_CONNECTION_INACTIVE`                     | The connector or connection is inactive.                     |
| `409`                        | `IDEMPOTENCY_*_CONFLICT`                         | The idempotency key was replayed with a changed request body.           |
| `402`                        | `subscription_required` / `insufficient_credits` | The account cannot start a billed session.                              |

`CONNECTOR_CONNECTION_REQUIRED` and `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE`
are **deprecated.** The schemas stay on the wire, but create, rescope, and
prompt admission never emit them any more — see [Connector accounts and the
call-time gate](#connector-accounts-and-the-call-time-gate) for the denial
that replaced them (`connector_not_connected`, on the connector **call**, not
on session create).

## 10. Legacy storage

Older attribution columns and indexes remain in the database for deployment
compatibility. They are physical storage only.

New session and usage writes do not populate those columns. Public session and
usage contracts do not read, filter, group, or enforce limits from them.
