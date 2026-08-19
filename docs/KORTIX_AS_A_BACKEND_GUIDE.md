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
    "opencode_model": "kortix/glm-5.2",
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
  opencode_model: "kortix/glm-5.2",
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
| `require_connectors` | Requires listed connectors to resolve before sandbox startup.                          |

`runtime_context` accepts at most 64 scalar entries and 16 KiB. The API rejects
credential-like keys.

The wire field remains `opencode_model` for OpenCode compatibility.

## 3. Connectors

A connector is an agent-facing permission package for one provider
app. It contains:

- a project-unique slug
- a display name
- a provider configuration
- a provider app reference
- an authorization strategy
- connector policies

A connection is one connected account or credential for a connector.

Every connection under one connector uses the same policies. Create
two connectors when the same provider app needs two policy sets.

```yaml
connectors:
  - slug: gmail-read
    name: Gmail read only
    provider: pipedream
    app: gmail
    authorization_strategy: project
    policies:
      - match: search_email
        action: always_run
      - match: "*"
        action: block

agents:
  support:
    connectors: [gmail-read]
    connectors_required: [gmail-read]
```

### Authorization strategy

The authorization strategy is exactly one of:

- `project`
- `user`

A `project` connector accepts active project connections.

A `user` connector accepts only an active connection owned by the
acting project member.

A service account has no member identity. Therefore, its sessions must use
`project` connectors. A personal access token can use an eligible
`user` connection owned by the token's member.

The server enforces the strategy during:

- session creation
- default connection resolution
- explicit binding
- session rescope
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

### Required connectors

Declare `connectors_required` on the agent. Each entry must also exist in
`connectors`.

Session creation resolves required connectors before sandbox startup.
Missing connections return:

```json
{
  "code": "CONNECTOR_CONNECTION_REQUIRED",
  "message": "Connect the required connectors before starting this session.",
  "connector_connections": [
    {
      "id": "connector-connection-id",
      "slug": "gmail-read",
      "name": "Gmail read only",
      "authorization_strategy": "project"
    }
  ]
}
```

Both refusals are returned before the session row is inserted and before any
sandbox is provisioned, so a session blocked on a connector costs no tokens.

If a required slug has no configured connector, session creation
returns:

```json
{
  "error": "Required connector \"gmail-read\" is unavailable",
  "code": "REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE",
  "connectors": ["gmail-read"]
}
```

Each refusal lists every failing alias, so one retry can follow one round of
fixes. `connectors` and `connector_connections` are the machine-readable lists;
never parse `error` or `message`.

The two codes have different remedies. `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE`
means the connector does not exist in the project — the project owner
adds it, and no end-user action can substitute.
`CONNECTOR_CONNECTION_REQUIRED` means the connector exists but has no
connection this caller may use; each entry carries the connector `id` to
start a connect flow with. When the strategy is `user`, that flow belongs to the
end-user's own account, which is why a service-account credential cannot clear
it on their behalf — mint a setup link and send them through it.

`REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` outranks
`CONNECTOR_CONNECTION_REQUIRED` when both apply in one request.

Both are distinct from `403 CONNECTOR_NOT_ASSIGNED`, which means the agent is
not granted the connector at all. That is a manifest fault, and connecting an
account never clears it.

Create or reconnect the required connection. Then retry session creation.

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
| `404` create / `403` rescope | `CONNECTOR_CONNECTION_NOT_FOUND`                    | The connection is absent or violates the connector strategy. |
| `404`                        | `SECRET_IDENTIFIER_NOT_FOUND`                    | The secret allowlist names an unknown identifier.                       |
| `409`                        | `CONNECTOR_CONNECTION_REQUIRED`               | A mandatory connector has no active valid connection. Lists every failing connector in `connector_connections`. |
| `409`                        | `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE`         | A required slug has no configured connector. Lists every failing alias in `connectors`. |
| `409`                        | `CONNECTOR_NOT_PIPEDREAM`                        | The alias is a connector on the project but not a Pipedream one, so no Quick Connect link exists for it. |
| `409`                        | `CONNECTOR_PIPEDREAM_APP_MISSING`                | The Pipedream connector names no app, so no connect link can be built.  |
| `409` create / `403` rescope | `CONNECTOR_CONNECTION_INACTIVE`                     | The connector or connection is inactive.                     |
| `409`                        | `IDEMPOTENCY_*_CONFLICT`                         | The idempotency key was replayed with a changed request body.           |
| `402`                        | `subscription_required` / `insufficient_credits` | The account cannot start a billed session.                              |

## 10. Legacy storage

Older attribution columns and indexes remain in the database for deployment
compatibility. They are physical storage only.

New session and usage writes do not populate those columns. Public session and
usage contracts do not read, filter, group, or enforce limits from them.
