# Secret delivery control plane

**Status:** Implemented for runtime, managed consumers, policy-bound HTTPS calls,
and egress-enforced delivery through ONE mechanism on every provider — the
in-guest shim plus server-side handle substitution. The Platinum provider edge
and the `network_boundary_shim` flag are deleted.
**User-facing model:** `docs/specs/2026-08-19-secrets-exposure-usage-model.md`
(exposure/usage). This document stays the mechanism reference.

## Problem and contract

Encryption at rest does not protect a secret after Kortix places its plaintext
value in a sandbox. Agent code can read, print, copy, or forward every runtime
environment variable.

Kortix therefore separates four decisions:

1. **Identifier:** The stable handle used by grants and session allowlists.
2. **Key:** The environment variable or provider key, such as
   `ANTHROPIC_API_KEY`. Several identifiers can use the same key.
3. **Consumer:** The only Kortix subsystem allowed to use the decrypted value.
4. **Strategy:** The delivery method, or a decision to deliver nothing.

The system contract is:

> A secret reaches only its approved consumer through its approved strategy.
> Each managed use writes a metadata-only audit event.

The product term is **Secret**. An environment variable is one delivery form.

## Strategies and consumers

| Strategy | Consumer | Sandbox receives | Current behavior |
| --- | --- | --- | --- |
| `runtime` | `sandbox` | Plaintext value | Available for code that must read the value locally |
| `broker` | `llm_gateway` | Nothing | Kortix authenticates provider requests server-side |
| `broker` | `connector` | Nothing | Kortix resolves automation and channel credentials server-side |
| `broker` | `http_broker` | Opaque session handle | Kortix makes one policy-bound HTTPS request |
| `broker` | `git_proxy` | Nothing | Git uses its separate encrypted credential path |
| `egress` | `network` | A self-describing handle | Kortix substitutes the real value for the handle outside the guest, on exact approved HTTPS hosts |
| `denied` | none | Nothing | Stored but disabled |

`runtime` is the only strategy that sends plaintext to a sandbox. No managed
strategy silently falls back to `runtime`. An `egress` row does put a value
under its env key, but that value is a HANDLE: an `[A-Za-z0-9_-]`-safe,
self-describing string with an HMAC tag, worth nothing off an approved host.

The user-facing model maps onto this table: `runtime`/`sandbox` is **environment**
exposure, `egress`/`network` is **egress-enforced** exposure, every `broker`
consumer and `denied` is **none**. See the spec, §3.

Generic `git_proxy` policy updates remain unavailable. Git authorization uses a
separate typed API and credential store. It applies the same server-only and
audit requirements.

Transparent `egress` has ONE mechanism on every provider. The in-guest shim
terminates the guest's TLS for approved hosts and relays to the broker route,
which substitutes the real value for the handle server-side. Daytona, E2B and
Platinum behave identically. There is no provider requirement and no feature
flag, so the strategy is never rejected for unavailability. See
[Egress-enforced delivery](#egress-enforced-delivery).

An `egress` policy is a HOST LIST. It does not support wildcard hosts. A legacy
row that still carries `inject` additionally rejects method filters, path
filters, and non-header injection slots. Kortix rejects an unenforceable policy
with `400`.

## Access flow

```text
project secret
    |
    v
principal authorization
    |
    v
agent grant AND session allowlist
    |
    v
stored strategy AND configured consumer
    |
    +-- runtime/sandbox ------> plaintext environment variable
    |
    +-- broker/managed -------> server decrypts, uses, audits, discards
    |
    +-- broker/http_broker ---> session handle + outbound policy
    |
    +-- egress/network -------> handle in env; exact-host server-side substitution
    |
    +-- denied/unsupported ---> no value and a failed or denied result
```

For session-bound access, an empty session allowlist grants zero project
secrets. The API intersects the immutable agent grant with the current session
allowlist before it materializes runtime values or HTTP broker handles.
Reserved `KORTIX_*` names cannot come from project secret rows.

The secret consumer resolver performs these steps:

1. Load shared values and the active personal override, when one exists.
2. Match the configured strategy and consumer.
3. Decrypt only the selected value.
4. Write `secret.consumer.used`, `denied`, `missing`, or `invalid`.
5. Return the value only to the named server subsystem.

The sandbox uses its session-scoped `KORTIX_TOKEN` to call Kortix. Provider,
connector, Git, and automation credentials do not need to enter the sandbox.

## Creation defaults and migration

New generic secrets default to `runtime` with the `sandbox` consumer. This is an
explicit compatibility choice for arbitrary local tools.

When a caller supplies only `runtime` or `denied`, the API infers `sandbox` or
no consumer. Broker creation always requires an explicit server consumer.

Known LLM credential keys default to `broker` with the `llm_gateway` consumer
when the client omits both fields. The provider settings UI also sends this
policy explicitly. A caller can still request `runtime` and `sandbox` when a
local process genuinely needs that provider key.

Migration `20260805205105000_isolate_existing_llm_credentials.sql` moves the
catalog's existing LLM credentials to `broker` and `llm_gateway`. It clears
obsolete network policies and handles. It also marks the value as requiring
rotation because an earlier sandbox can retain plaintext.

A switch away from `runtime` updates active sandboxes immediately where the
provider supports environment synchronization. Rotation is still required to
invalidate copies that may already exist outside Kortix control.

## Multiple credentials and provider fallback

The database key is `(project_id, identifier)`, not `(project_id, key)`. Two
identifiers can therefore store different values for one provider key:

```text
identifier: ANTHROPIC_API_KEY          key: ANTHROPIC_API_KEY
identifier: anthropic-backup           key: ANTHROPIC_API_KEY
```

The LLM gateway tries credentials in this order:

1. The canonical identifier that equals the key.
2. Other identifiers by most recent update time, then identifier.
3. The managed Kortix provider, when configured.

An active personal override replaces its matching shared identifier. It does
not remove other identifiers from the fallback list.

The gateway advances to another credential for the same provider after a
thrown `401`, a terminal authentication `400`, or a terminal authentication
error in a stream. A single invalid credential preserves the upstream terminal
error. Existing provider and model fallback rules still handle their defined
`402`, `403`, and `429` cases.

## HTTPS broker

The HTTP broker is for credentials that Kortix can inject into one controlled
HTTPS request. Its policy contains:

- one or more exact approved hosts;
- optional HTTP method and path restrictions;
- one injection slot: header, query parameter, or JSON body field;
- an optional handle prefix.

Each session receives a revisioned opaque handle. A strategy change revokes its
active handles. The broker checks the current agent grant, session allowlist,
stored policy, and handle snapshot before decrypting the value.

An agent grant of `env: all` is a ceiling. It does not materialize HTTP broker
handles by itself. The session must also contain an explicit allowlist with the
secret identifier. The broker route intersects both policies again on every
call. This rule limits a leaked session token to the broker secrets selected for
that session.

The broker enforces HTTPS. It blocks private, loopback, link-local, metadata,
and rebinding targets. It reevaluates redirects. It bounds request and response
sizes. It strips sensitive response headers and never records request bodies,
response bodies, query values, injected headers, handles, or secret values.

The CLI configures the policy, then sends the request:

```bash
kortix secrets delivery API_KEY broker \
  --consumer http-broker \
  --allow-host api.example.com \
  --allow-method POST \
  --allow-path '/v1/*' \
  --inject-header Authorization \
  --template 'Bearer {{secret}}'

kortix secrets call API_KEY https://api.example.com/v1/resource \
  --method POST \
  --data '{"input":"value"}'
```

## Egress-enforced delivery

Egress-enforced delivery serves ordinary sandbox HTTP clients that cannot call
the explicit broker API. ONE mechanism serves it on every provider:

```text
agent's ordinary HTTP client
  └─▶ in-guest shim (terminates TLS for approved hosts ONLY; holds NO secret)
       └─▶ broker route  (apps/api/src/projects/routes/secret-broker.ts)
            host gate → grant ∩ session allowlist → decrypt
            → substitute handle → call upstream → redact echoes
            → per-request audit → return response
```

The sandbox env holds `IDENTIFIER=<handle>`. The agent uses that variable
wherever it would have used the credential; the relay swaps it for the real
value on an approved host. Compared with the explicit HTTPS broker:

- the agent grant and session allowlist must name the secret explicitly;
- every destination must be an exact HTTPS host;
- the sandbox holds a handle, never the value, an alias, or a rendered header;
- an upstream response that echoes the credential comes back with `[REDACTED]`
  in its place — one mechanism, one symptom;
- rotation needs no sandbox restart: the relay reads the current value on the
  next request;
- every relayed request writes an audit record.

There is no provider gate and no feature flag. `startNetworkBoundaryArm`
(`apps/api/src/projects/lib/sandbox-env-sync.ts`) no longer calls a provider
adapter; it keeps the digest/skip and revocation accounting only.

```bash
kortix secrets delivery ANTHROPIC_API_KEY egress \
  --allow-host api.anthropic.com
```

### The handle

`mintHandle` / `parseHandle` (`apps/api/src/secrets/strategy.ts`) produce a
self-describing, `[A-Za-z0-9_-]`-safe string: a marker, a random lookup id, and
an HMAC tag verified statelessly before any database work. A known model key can
carry a vendor-shaped prefix (`sk_live_…`) for format-validating SDKs; the
prefix comes from the known-key catalog and is NEVER derived from the real
value.

`resolveSecretDelivery` returns `emit: 'handle'` for an `egress` row, so
`emitsValue` is true and the env builder emits the key. An `egress` identifier
therefore DOES appear in `KORTIX_PROJECT_SECRET_NAMES` — the value under it is
the handle.

### Substitution

In the relay, for destination host H:

1. Resolve the session's spendable handles — the agent grant intersected with
   the session allowlist, then each handle's FROZEN policy snapshot matched
   against the request shape. Substitution never widens who may spend.
2. Scan header values, URL path and query, and the body for each handle in four
   representations: raw, URL-encoded, base64, JSON-escaped — the dual of
   `redactSecretFromResponse` (`apps/api/src/secrets/http-broker.ts`), sharing
   the same encoding machinery.
3. Replace handle with the real value and recompute `content-length`. The relay
   is fully buffered.
4. `classifyPresentedHandles` (`apps/api/src/secrets/handle-substitution.ts`)
   runs BEFORE substitution, on the bytes the guest sent, and classifies every
   handle that was not honored:

   | Reason | Meaning |
   | --- | --- |
   | `forged` | The HMAC tag does not verify. Nobody minted this handle. |
   | `stolen` | The tag verifies, but the handle is not one of this session's active handles. |
   | `host_denied` | The session may spend it, but its frozen policy does not admit this destination. |

   Refusals are written as `secret.handle.refused` with outcome `denied`, and
   summarized again on `secret.broker.completed`. Collapsing the three into
   "not substituted" would make a credential-theft attempt look like a typo in a
   host list.

### What the guest holds

A handle, and nothing else. The real value, and the rendered header of a legacy
`inject` row, stay outside the sandbox:

- `resolveNetworkBoundaryBindings` (`apps/api/src/secrets/network-boundary.ts`)
  resolves the binding set on the API. No provider adapter receives it.
- The catalog entry the agent reads (`delivery: 'network'` in
  `KORTIX_SECRET_CAPABILITIES`) carries the env var name, the exact hosts,
  `scheme: 'https'`, `readable_in_sandbox: false`, and `on_echo: 'redact'`. It
  never carries a value.
- A handle sent to a host outside the list arrives as a literal string. The
  upstream rejects it.

### The two prerequisites

Both must hold. There is no third: the provider/flag prerequisite is deleted,
and the header-template prerequisite does not exist for a substitution row.

| # | Requirement | Where it is set | Result when wrong |
| --- | --- | --- | --- |
| 1 | An agent `secrets:` list NAMES the identifier | `kortix.yaml`, by hand or through the grant route below | `resolveSecretDelivery` withholds the row. No handle in the env. |
| 2 | The request's destination host is on the policy list | Secret editor -> hosts, or `--allow-host` | The handle travels as a literal string. Upstream returns `401`. |

Requirement 1 is stricter than every other strategy. `resolveSecretDelivery`
(`apps/api/src/secrets/strategy.ts`) delivers a non-`runtime` row only when
`agentGrantEnv` is a `string[]` that contains the identifier:

```ts
const grant = input.agentGrantEnv ?? null;
if (Array.isArray(grant)) {
  if (!listAdmits(grant, input.identifier)) return withheld('agent_grant_excludes');
} else if (strategy !== 'runtime') {
  return withheld('agent_grant_unscoped');
}
```

`secrets: all` resolves to the string `'all'`, not an array. It therefore fails
exactly like an absent grant, with reason `agent_grant_unscoped`. A project with
no `agents:` block resolves to a null grant and can never deliver an egress
secret. Membership is by IDENTIFIER, case-insensitive. It is never by env-var
key: one key can carry several identifiers.

A non-`runtime` row also needs a session id, because a handle is minted per
(session, secret). Without one the row emits nothing (`no_session`) rather than
falling back to plaintext.

`SecretSchema.delivery_blocked_reason` reports only the certain case. It is
`'no_agent_grant'` when the manifest loaded and no agent's explicit list names
the identifier. It is `null` when the row is granted, when the strategy needs no
grant, or when the manifest could not be read. A warning that fires on an
unreadable manifest is worse than no warning, so uncertainty always renders as
`null`.

### Policy shape

`networkBoundaryPolicyError` (`apps/api/src/secrets/network-boundary.ts`)
accepts only the controls this path can actually enforce, and it validates two
shapes:

- **Substitution row** — no `inject`. The default since the exposure/usage
  model. The policy is a host list; the agent's own client decides where the
  credential goes, so there is no header, template, method or path to have an
  opinion about.
- **Legacy injection row** — `inject` present. Served exactly as before, and it
  keeps every prohibition it ever had.

| Rejected input | Applies to | Message |
| --- | --- | --- |
| A broker `backend` | both | `Network-boundary delivery does not accept a broker backend` |
| `on_no_match` other than `deny` | both | `Network-boundary delivery must deny unmatched requests` |
| `tls` other than `terminate` | both | `Network-boundary delivery requires TLS termination` |
| A wildcard host such as `*.example.com` | both | `Network-boundary delivery requires exact hosts` |
| A rule-level `inject` with no policy-level slot | legacy | `Network-boundary delivery cannot inject without a policy-level slot` |
| A query or JSON-body injection | legacy | `Network-boundary delivery supports header injection only` |
| Any `methods` entry | legacy | `Network-boundary delivery cannot enforce HTTP method restrictions` |
| Any `path` | legacy | `Network-boundary delivery cannot enforce path restrictions` |
| A per-rule header or template that differs from the policy default | legacy | `Every network-boundary rule must use the same header and template` |

Host matching is exact. `api.example.com` never covers
`uploads.api.example.com`. List every host explicitly. The API returns `400`
with `code: 'secret_delivery_policy_invalid'`.

### Destination uniqueness — legacy injection rows only

One `(host, header)` pair per project, for rows that carry `inject`.
`findBoundaryDestinationConflict` (`apps/api/src/secrets/network-boundary.ts`)
returns `null` immediately for a substitution row, because a substitution row
claims no header: each handle maps to its own value, so two substitution rows on
one host are legal and both substitute in the same request.

The check runs at save time on `POST /:projectId/secrets` and on
`PUT /:projectId/secrets/:identifier/strategy`. A collision returns `409`:

```json
{
  "error": "BOUNDARY_TEST already injects the \"authorization\" header for postman-echo.com. Two secrets cannot target the same host and header — give STRIPE_API_KEY a different header, or a different host.",
  "code": "secret_boundary_destination_conflict",
  "conflict": { "identifier": "BOUNDARY_TEST", "host": "postman-echo.com", "header": "authorization" }
}
```

`conflict.identifier` is the secret that already holds the destination. The
sentence names both: the incumbent first, then the secret being saved.

### HTTPS only

The shim terminates TLS to substitute, so a policy host must be called over
HTTPS. The shim answers only HTTPS `CONNECT` and is advertised through the HTTPS
proxy variables alone. An `http://` call to a policy host bypasses it entirely:
the request leaves carrying the handle, and the upstream answers `401`.

### One symptom set: redact

The relay redacts a credential the upstream echoes back
(`redactSecretFromResponse`, `apps/api/src/secrets/http-broker.ts`). There is no
second mechanism and no second symptom table. `NETWORK_BOUNDARY_NOTES`
(`apps/api/src/projects/secret-capabilities.ts`) is a single list, and every
surface describes this one set.

| Observation on a policy host | Meaning |
| --- | --- |
| `200`, the echoed credential reads `[REDACTED]` | Working. The real value went upstream; the echo was redacted on the way back. |
| `200`, the echoed credential reads as the handle | The swap did not run. Check the agent grant and the host list. |
| `401` | The swap did not run. Same two checks. |
| An empty reply, or a connection error | A REAL failure. The relay did not complete. |

An echo endpoint is the clearest probe there is. Pair it with a non-echoing
endpoint on the same host, which is the only probe that proves reachability.

### Save-time sync

`POST /:projectId/secrets` and `PUT /:projectId/secrets/:identifier/strategy`
push the binding to every active sandbox and report the outcome in
`delivery_sync`:

```ts
delivery_sync: {
  ok: boolean;
  targeted: number;
  synced: number;
  failed: number;
  failures: Array<{ session_id: string; sandbox_id: string | null; reason: string }>;
} | null
```

`null` means no sync ran: the row is not an egress secret, or the project has no
active session. A partial failure returns `ok: false` with one entry per session
that did not take the binding. The save itself still succeeds; the stored policy
is the source of truth and the next session start reapplies it.

### File map

| Concern | File |
| --- | --- |
| Delivery decision for one row | `apps/api/src/secrets/strategy.ts` |
| Policy validation, bindings, destination conflicts | `apps/api/src/secrets/network-boundary.ts` |
| Handle mint, parse, scan | `apps/api/src/secrets/strategy.ts` |
| Refused-handle classification (`forged` / `stolen` / `host_denied`) | `apps/api/src/secrets/handle-substitution.ts` |
| Substitution and response redaction | `apps/api/src/secrets/http-broker.ts` |
| Shim relay (`egress`/`network` through the broker engine) | `apps/api/src/projects/routes/secret-broker.ts` |
| Agent-facing catalog text | `apps/api/src/projects/secret-capabilities.ts` |
| In-guest shim | `apps/kortix-sandbox-agent-server/src/egress-shim/` |
| Session grant + allowlist resolution | `apps/api/src/projects/lib/network-secret-boundary.ts` |
| Agents-map merge and upsert behind the grant | `apps/api/src/projects/lib/agent-config-v2.ts` |
| Default-deny for an agent the manifest omits | `apps/api/src/projects/agents.ts` |
| Save routes | `apps/api/src/projects/routes/r3.ts` |
| Web editor | `apps/web/src/features/workspace/customize/sections/view/secrets-view.tsx` |
| CLI | `apps/cli/src/commands/secrets.ts` |

## Repairing a missing agent grant

Requirement 1 — the agent grant — is the one prerequisite the Secrets page
cannot satisfy with a secret write: it
needs a manifest commit, not a secret write. `delivery_blocked_reason` named the
problem and stopped there. The API now performs the edit as well, so a surface
that renders the warning can also clear it.

```http
POST /v1/projects/{projectId}/secrets/{identifier}/grant
{ "agent": "my-agent" }
```

```json
{
  "identifier": "STRIPE_API_KEY",
  "agent": "my-agent",
  "already_granted": false,
  "adopted_governance": true
}
```

| Outcome | Status | Code |
| --- | --- | --- |
| Granted, or already granted | `200` | — |
| The manifest is `kortix.toml` | `400` | `manifest_v1_unsupported` |
| Unknown project, secret, or manifest | `404` | — |
| The secret's strategy is `denied` | `409` | `secret_not_grantable` |

The route resolves the secret by identifier on the project, loads the manifest
for edit, and calls `grantSecretToAgentV2`
(`apps/api/src/projects/lib/agent-config-v2.ts`). The merge only ever widens:

| The agent's current `secrets` | Result |
| --- | --- |
| Missing from the roster | Upserted with `secrets: [identifier]` |
| An explicit list | The identifier is appended; every other field survives |
| A list that already admits it | `already_granted: true`, no commit, no rewrite |
| `all` | Expanded to today's project identifiers plus this one |

The `all` expansion is not cosmetic. `resolveSecretDelivery` withholds an
`egress` or `broker` row from an `'all'` grant, so the grant must become an
explicit list for the secret to arrive. Writing only the new identifier would
revoke every other project secret from that agent, so the route writes out the
identifiers `'all'` resolves to today. Delivery is unchanged at that moment; a
secret added later needs its own grant.

The upsert is the one behavioral difference from
`PUT /:projectId/agents/:agentName/scope`, which sets `notFound` and answers
`404 agent_not_found` instead of creating (`applyAgentScopeV2` versus
`applyAgentBlockV2`). Membership compares case-insensitively. A real edit
commits `chore(agents): grant <IDENTIFIER> to <agent>`.

### `adopted_governance` reports a project-wide rule change

`adopted_governance` is `true` when the manifest declared NO agents before the
edit, and also when the repository had no manifest file at all and
`loadManifestForEdit` synthesized one. Both cases publish the project's first
roster. That single commit changes the project's default: `agents.ts` returns a
default-deny grant for any concrete agent the manifest does not list, so every
agent outside the new block loses every project secret — including the `runtime`
rows it received before the commit.

The web client therefore confirms before it sends a request that can set the
flag, and the confirmation tells the person to list every agent that needs
secrets. An API caller gets the same information after the fact in the response.

An `already_granted` response always reports `adopted_governance: false`. No
commit ran, so nothing was adopted.

A v1 manifest cannot express the agents map. `grantSecretToAgentV2` refuses
before any edit and returns `unsupportedV1`, which the route maps to `400
manifest_v1_unsupported`. The message asks for an upgrade to `kortix_version: 2`
instead of rewriting the file format for the project.

## Connector credentials

A connector can use one project secret as its server-side credential. The
secret must use `broker` strategy with the `connector` consumer. The connector
must use project-owned authorization and must not already have a stored
credential.

Configure the policy, then bind the connector:

```bash
kortix secrets delivery API_KEY broker --consumer connector
kortix connectors secret crm API_KEY
```

Use `kortix connectors secret crm --clear` before selecting a different secret
or storing a connector credential. Synchronizing the connector catalog keeps
the binding. Deleting the secret or changing its delivery policy returns `409`
until every connector binding is removed.

The web secret editor exposes the same binding as a connector checklist. It
never reads or copies the secret value. Connector calls resolve the current
value inside Kortix and send it only through the connector's declared
authentication scheme.

## Product surfaces

The API, SDK, CLI, and web UI expose `strategy`, `consumer`,
`delivery_status`, `delivery_blocked_reason`, and `requires_rotation`. Values
remain write-only.

`delivery_blocked_reason` is optional and nullable. Its only value today is
`'no_agent_grant'`. Treat `null` as "granted, not applicable, or unknown", never
as "blocked".

A surface that renders that reason should also offer the repair. The web editor
turns the warning into an agent choice and calls
`POST /:projectId/secrets/:identifier/grant`. It confirms the governance change
first, because a project's first `agents:` block default-denies every agent it
omits.

`POST /:projectId/secrets` and `PUT /:projectId/secrets/:identifier/strategy`
additionally return `delivery_sync`. No other route returns it.

The web editor presents ONE control — "Can your code read this value?" — over
the two orthogonal settings of the spec's §3:

- **No, enforce it at the network** (default) writes `egress`/`network` with a
  hosts-only policy;
- **Yes, put it in the environment** writes `runtime`/`sandbox`, in a warning
  tone;
- **Disabled** writes `denied`.

LLM gateway, Connector and Git are USAGES, assigned by their own flows and
rendered as read-only labels. Egress-enforced delivery is available on every
project, so the editor has no availability gate and no header/template fields.

The CLI supports the same available consumers through `kortix secrets
delivery`. `kortix connectors secret` manages connector bindings. `kortix
secrets ls --json` returns the stored delivery metadata.

The SDK exposes:

```ts
await project.secrets.upsert({
  identifier: "anthropic-primary",
  name: "ANTHROPIC_API_KEY",
  value,
  strategy: "broker",
  consumer: "llm_gateway",
});

await project.secrets.setStrategy("WEBHOOK_TOKEN", "broker", {
  consumer: "http_broker",
  egress_policy: {
    backend: "kortix_fetch",
    rules: [{ host: "api.example.com", methods: ["POST"], path: "/v1/" }],
    inject: { kind: "header", name: "Authorization", template: "Bearer {{secret}}" },
  },
});
```

Session-scoped agents call the HTTP broker route directly with their
`KORTIX_TOKEN`. Human project tokens can configure policy but cannot execute a
session-bound broker request.

## Audit and revocation

Configuration changes write these semantic actions in the same database
transaction as the mutation:

- `secret.created`
- `secret.updated`
- `secret.deleted`
- `secret.strategy.changed`

Managed access writes:

- `secret.consumer.used`
- `secret.consumer.denied`
- `secret.consumer.missing`
- `secret.consumer.invalid`
- `secret.consumer.refreshed`
- `secret.consumer.refresh_failed`
- `secret.handle.issued`
- `secret.handle.refused`
- `secret.broker.requested`
- `secret.broker.completed`
- `secret.broker.failed`

Events include account, project, session, actor, source, secret identifier,
consumer, strategy, outcome, and safe upstream metadata when available. They
exclude plaintext values, encrypted envelopes, provider tokens, opaque handles,
authorization headers, query values, request bodies, and response bodies.

Deleting a secret removes its usable value. Changing its strategy revokes
active HTTP broker handles. Rotating a value changes subsequent server-side use
without returning the new value to a client.

## Failure and edge-case behavior

- Missing policy data fails closed for managed delivery.
- A consumer mismatch returns no value and writes a denial audit event.
- `denied` blocks runtime and every managed consumer.
- A reused identifier with a different key returns `409`.
- A broker policy without a host or injection slot returns `400`.
- A generic unsupported broker backend returns `409`.
- An unenforceable egress policy returns `400`.
- Two LEGACY injection rows that claim one `(host, header)` pair return `409`
  with `code: 'secret_boundary_destination_conflict'`.
- Two substitution rows on one host are accepted. Both substitute in one
  request.
- An egress secret never blocks session startup for provider reasons. Every
  provider runs the same mechanism.
- Plain HTTP to a policy host is not intercepted. The handle leaves as a literal
  string.
- A response that would echo an egress secret is returned with `[REDACTED]` in
  its place.
- A handle with an invalid HMAC tag is not substituted and is audited as
  `forged`. A valid handle this session may not spend is audited as `stolen`. A
  spendable handle on an unlisted host is audited as `host_denied`.
- A failed push to a running sandbox returns `delivery_sync.ok === false`. The
  save still succeeds.
- A grant for an identifier the agent already admits returns `200` with
  `already_granted: true` and makes no commit.
- A grant that adds the project's first `agents:` block returns
  `adopted_governance: true`. From that commit on, an unlisted agent receives no
  project secret of any strategy.
- A grant against a `kortix.toml` project returns `400` with
  `code: 'manifest_v1_unsupported'`.
- A grant for a `denied` secret returns `409` with
  `code: 'secret_not_grantable'`.
- A stale, expired, or revoked session handle returns `409`.
- A host, method, or path mismatch returns `403`.
- A connector binding blocks secret deletion and incompatible strategy changes
  with `409`.
- A connector cannot combine a bound project secret with a stored credential.
- Invalid upstream DNS or a private target returns a broker error without a
  request.
- Personal overrides use the shared row's delivery policy.
- Multiple values for one key keep identifier-based authorization and audit
  attribution.

## Verification requirements

Every change to this control plane must prove these paths:

1. `runtime` appears in the selected sandbox environment.
2. Managed and denied values do not appear in the sandbox environment.
3. Every server consumer resolves only its configured secrets.
4. The HTTP broker accepts a matching policy and rejects mismatches.
5. Multiple provider credentials use deterministic fallback.
6. Rotation changes future use without exposing the value.
7. Audit rows contain reconstruction metadata and no secret material.
8. API, SDK, CLI, and web behavior agree on the stored policy.
9. A grant writes the identifier into the named agent, clears
   `delivery_blocked_reason`, and preserves that agent's other governance
   fields. Repeating it commits nothing.
10. An egress row puts a HANDLE in the sandbox env, the relay substitutes the
    real value on a listed host, an echo comes back `[REDACTED]`, and the raw
    value appears nowhere in the guest.
11. A handle sent to an unlisted host arrives as a literal string, a forged-tag
    handle is audited as `forged`, and a handle this session may not spend is
    audited as `stolen`.

Egress-enforced delivery still requires a live test, on a real session. It must
prove substitution, sandbox non-disclosure, rotation, revocation, and echo
handling. One mechanism means one live test per provider rather than one per
mechanism, and the probe is the echo endpoint: a `200` carrying `[REDACTED]`
proves substitution and echo scrubbing in the same response. Pair it with a
non-echoing endpoint on the same host, which is the only probe that proves
reachability.

## Related specifications

- [`2026-07-26-agent-scoped-secret-injection.md`](./specs/2026-07-26-agent-scoped-secret-injection.md)
- [`2026-07-26-secret-delivery-policy.md`](./specs/2026-07-26-secret-delivery-policy.md)
- [`specs/2026-08-19-secrets-exposure-usage-model.md`](./specs/2026-08-19-secrets-exposure-usage-model.md)
  — the approved exposure/usage model this document implements
- [`NETWORK_BOUNDARY_WITHOUT_PLATINUM.md`](./NETWORK_BOUNDARY_WITHOUT_PLATINUM.md) — why the
  shim exists, and the live proof of the mechanism (design history)
