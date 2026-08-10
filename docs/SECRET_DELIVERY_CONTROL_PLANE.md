# Secret delivery control plane

**Status:** Implemented for runtime, managed consumers, policy-bound HTTPS calls,
and Platinum network-boundary delivery

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

| Strategy  | Consumer      | Sandbox receives      | Current behavior                                               |
| --------- | ------------- | --------------------- | -------------------------------------------------------------- |
| `runtime` | `sandbox`     | Plaintext value       | Available for code that must read the value locally            |
| `broker`  | `llm_gateway` | Nothing               | Kortix authenticates provider requests server-side             |
| `broker`  | `connector`   | Nothing               | Kortix resolves automation and channel credentials server-side |
| `broker`  | `http_broker` | Opaque session handle | Kortix makes one policy-bound HTTPS request                    |
| `broker`  | `git_proxy`   | Nothing               | Git uses its separate encrypted credential path                |
| `egress`  | `network`     | Nothing               | Platinum injects one header for exact approved HTTPS hosts     |
| `denied`  | none          | Nothing               | Stored but disabled                                            |

`runtime` is the only strategy that sends plaintext to a sandbox. No managed
strategy silently falls back to `runtime`.

Generic `git_proxy` policy updates remain unavailable. Git authorization uses a
separate typed API and credential store. It applies the same server-only and
audit requirements.

Transparent `egress` is provider-capability based. Platinum stores a write-only
replica, attaches the exact authorized set to each sandbox, and injects one
header for exact HTTPS hosts outside the guest. Daytona does not implement this
boundary. A deployment without Platinum rejects the strategy with `409`.

The transparent path does not support wildcard hosts, method or path filters,
query parameters, or body injection. These controls require the explicit HTTPS
broker. Kortix rejects an unenforceable transparent policy with `400`.

## Access flow

```text
workspace secret
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
    +-- egress/network --------> provider-owned exact-host header transform
    |
    +-- denied/unsupported ---> no value and a failed or denied result
```

For session-bound access, an empty session allowlist grants zero workspace
secrets. The API intersects the immutable agent grant with the current session
allowlist before it materializes runtime values or HTTP broker handles.
Reserved `KORTIX_*` names cannot come from workspace secret rows.

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

## Network boundary

Network-boundary delivery serves ordinary sandbox HTTP clients that cannot call
the explicit broker API. Kortix registers the value with Platinum. Platinum
injects one header at its own egress edge. It is narrower than the HTTPS broker:

- the workspace must run the session on Platinum;
- the agent grant and session allowlist must name the secret explicitly;
- every destination must be an exact HTTPS host;
- the provider injects one configured header;
- the sandbox receives no value, alias, handle, or placeholder;
- an upstream response that echoes the credential is blocked;
- rotation updates the provider replica without restarting the sandbox;
- revocation detaches the binding before deleting the provider replica.

Configuration fails closed. A session with an authorized network secret cannot
start on a provider that lacks the boundary capability.

```bash
kortix secrets delivery ANTHROPIC_API_KEY egress \
  --allow-host api.anthropic.com \
  --inject-header x-api-key \
  --template '{{secret}}'
```

### What the guest holds

Nothing. The value, the rendered header, and the binding alias all stay outside
the sandbox:

- `resolveNetworkBoundaryBindings` (`apps/api/src/secrets/network-boundary.ts`)
  renders the header value on the API and returns it to the provider adapter.
- `syncPlatinumNetworkBoundary`
  (`apps/api/src/secrets/platinum-network-boundary.ts`) writes the write-only
  replica and attaches it to the sandbox by id. The `alias` field is provider
  bookkeeping and is sent only to Platinum.
- The env builder emits no name for an `egress` row, so
  `KORTIX_PROJECT_SECRET_NAMES` never lists it.

Verified on dev 2026-08-10. Inside a live Platinum session,
`env | grep -c <IDENTIFIER>` returns `0` while injection works. A policy host
presents the per-sandbox MITM certificate
`issuer: O=Platinum; CN=Platinum egress proxy (sandbox sbx_...)`, which the box
already trusts. A host outside the policy passes through untouched with its own
origin certificate.

### The three prerequisites

All three must hold. Each one used to fail silently.

| #   | Requirement                                            | Where it is set                                | Result when wrong                                                         |
| --- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | The session runs on Platinum                           | Customize -> Feature flags -> Sandbox provider | No binding is attached. The request leaves without the header.            |
| 2   | An agent `secrets:` list NAMES the identifier          | `kortix.yaml`                                  | `resolveSecretDelivery` withholds the row. No binding.                    |
| 3   | The header value template renders what the API expects | Secret editor -> Header value template         | The header carries the bare value with no scheme. Upstream returns `401`. |

Requirement 1 is workspace scope, not deployment scope.
`networkBoundaryDeliveryAvailable()` reports only that the deployment enables
Platinum. The web editor therefore gates the option on
`networkBoundaryAvailability(workspace)`
(`apps/web/src/features/workspace/customize/sections/view/secret-delivery.ts`),
which requires `default_sandbox_provider === 'platinum'`.

Requirement 2 is stricter than every other strategy. `resolveSecretDelivery`
(`apps/api/src/secrets/strategy.ts`) delivers a non-`runtime` row only when
`agentGrantEnv` is a `string[]` that contains the identifier:

```ts
const grant = input.agentGrantEnv ?? null;
if (Array.isArray(grant)) {
  if (!listAdmits(grant, input.identifier))
    return withheld("agent_grant_excludes");
} else if (strategy !== "runtime") {
  return withheld("agent_grant_unscoped");
}
```

`secrets: all` resolves to the string `'all'`, not an array. It therefore fails
exactly like an absent grant, with reason `agent_grant_unscoped`. A workspace with
no `agents:` block resolves to a null grant and can never deliver an egress
secret. Membership is by IDENTIFIER, case-insensitive. It is never by env-var
key: one key can carry several identifiers.

`SecretSchema.delivery_blocked_reason` reports only the certain case. It is
`'no_agent_grant'` when the manifest loaded and no agent's explicit list names
the identifier. It is `null` when the row is granted, when the strategy needs no
grant, or when the manifest could not be read. A warning that fires on an
unreadable manifest is worse than no warning, so uncertainty always renders as
`null`.

### Policy shape

`networkBoundaryPolicyError` (`apps/api/src/secrets/network-boundary.ts`)
accepts only the controls Platinum can enforce. A stored policy must never look
narrower than the data path that applies it.

| Rejected input                                                     | Message                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A broker `backend`                                                 | `Network-boundary delivery does not accept a broker backend`        |
| `on_no_match` other than `deny`                                    | `Network-boundary delivery must deny unmatched requests`            |
| `tls` other than `terminate`                                       | `Network-boundary delivery requires TLS termination`                |
| A query or JSON-body injection                                     | `Network-boundary delivery supports header injection only`          |
| A wildcard host such as `*.example.com`                            | `Network-boundary delivery requires exact hosts`                    |
| Any `methods` entry                                                | `Network-boundary delivery cannot enforce HTTP method restrictions` |
| Any `path`                                                         | `Network-boundary delivery cannot enforce path restrictions`        |
| A per-rule header or template that differs from the policy default | `Every network-boundary rule must use the same header and template` |

Host matching is exact. `api.example.com` never covers
`uploads.api.example.com`. List every host explicitly. The API returns `400`
with `code: 'secret_delivery_policy_invalid'`.

### Destination uniqueness

One `(host, header)` pair per workspace. `findBoundaryDestinationConflict`
(`apps/api/src/secrets/network-boundary.ts`) compares a candidate against every
other egress row. Host and header compare lowercased. The same identifier never
conflicts with itself. A row with a null policy, or a non-header injection, is
skipped.

The check runs at save time on `POST /:workspaceId/secrets` and on
`PUT /:workspaceId/secrets/:identifier/strategy`. A collision returns `409`:

```json
{
  "error": "BOUNDARY_TEST already injects the \"authorization\" header for postman-echo.com. Two secrets cannot target the same host and header — give STRIPE_API_KEY a different header, or a different host.",
  "code": "secret_boundary_destination_conflict",
  "conflict": {
    "identifier": "BOUNDARY_TEST",
    "host": "postman-echo.com",
    "header": "authorization"
  }
}
```

`conflict.identifier` is the secret that already holds the destination. The
sentence names both: the incumbent first, then the secret being saved.

Two secrets on the same host with DIFFERENT headers are legal. Platinum injects
both. `resolveNetworkBoundaryBindings` keeps its start-time throw as the last
line of defense. The save-time check exists so the failure reaches the person
who caused it, not a session that starts hours later.

### HTTPS only

The proxy needs to terminate TLS to rewrite a header. Plain HTTP to a policy
host is refused:

```text
egress to "<host>" is blocked: this sandbox's policy puts a secret in a request
header for this host, and that requires HTTPS
```

A test that uses `http://` reads as a network fault. It is a policy refusal.

### Echo blocking is the verification trap

`onEcho` is hardcoded `'block'` in `NetworkBoundarySecretBinding`. When an
upstream response would return the secret to the guest, the proxy kills the
connection. The guest sees `curl: (52) Empty reply from server`.

An echo service is therefore the worst possible test target. Success there is a
dead connection, which is exactly what a broken boundary also produces. One
probe cannot separate the two. Use two.

| Probe        | Target                                                      | Correct result                       | Meaning                                                        |
| ------------ | ----------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Reachability | A policy host endpoint that does NOT echo request headers   | `200`                                | The host is reachable and the proxy passes traffic.            |
| Injection    | An endpoint on the same host that DOES echo request headers | `curl: (52) Empty reply from server` | The header was present and the echo guard killed the response. |

A `200` with the secret visible in the body would mean the guard failed. A
`curl: (52)` on the non-echoing probe means the policy host is unreachable, not
that injection worked.

### Save-time sync

`POST /:workspaceId/secrets` and `PUT /:workspaceId/secrets/:identifier/strategy`
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

`null` means no sync ran: the row is not an egress secret, or the workspace has no
active session. A partial failure returns `ok: false` with one entry per session
that did not take the binding. The save itself still succeeds; the stored policy
is the source of truth and the next session start reapplies it.

### File map

| Concern                                            | File                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| Delivery decision for one row                      | `apps/api/src/secrets/strategy.ts`                                         |
| Policy validation, bindings, destination conflicts | `apps/api/src/secrets/network-boundary.ts`                                 |
| Provider replica, attach, arm, erase               | `apps/api/src/secrets/platinum-network-boundary.ts`                        |
| Deployment capability flag                         | `apps/api/src/secrets/network-boundary-availability.ts`                    |
| Session grant + allowlist resolution               | `apps/api/src/workspaces/lib/network-secret-boundary.ts`                   |
| Provider adapter and teardown                      | `apps/api/src/platform/providers/platinum.ts`                              |
| Save routes                                        | `apps/api/src/workspaces/routes/r3.ts`                                     |
| Web editor                                         | `apps/web/src/features/workspace/customize/sections/view/secrets-view.tsx` |
| CLI                                                | `apps/cli/src/commands/secrets.ts`                                         |

## Connector credentials

A connector can use one workspace secret as its server-side credential. The
secret must use `broker` strategy with the `connector` consumer. The connector
must use workspace-owned authorization and must not already have a stored
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

`POST /:workspaceId/secrets` and `PUT /:workspaceId/secrets/:identifier/strategy`
additionally return `delivery_sync`. No other route returns it.

The web editor provides these choices:

- **Readable in sandbox** for `runtime` and `sandbox`;
- **LLM gateway** for provider requests;
- **Connector** for connector authorization;
- **Automation** for Connector actions and channels;
- **HTTPS broker** for a policy-bound request;
- **Network boundary** for exact-host header injection on Platinum;
- **Stored but disabled** for `denied`.

The UI enables network delivery only when Platinum is available. It labels the
provider requirement and the controls that the provider can enforce.

The CLI supports the same available consumers through `kortix secrets
delivery`. `kortix connectors secret` manages connector bindings. `kortix
secrets ls --json` returns the stored delivery metadata.

The SDK exposes:

```ts
await workspace.secrets.upsert({
  identifier: "anthropic-primary",
  name: "ANTHROPIC_API_KEY",
  value,
  strategy: "broker",
  consumer: "llm_gateway",
});

await workspace.secrets.setStrategy("WEBHOOK_TOKEN", "broker", {
  consumer: "http_broker",
  egress_policy: {
    backend: "kortix_fetch",
    rules: [{ host: "api.example.com", methods: ["POST"], path: "/v1/" }],
    inject: {
      kind: "header",
      name: "Authorization",
      template: "Bearer {{secret}}",
    },
  },
});
```

Session-scoped agents call the HTTP broker route directly with their
`KORTIX_TOKEN`. Human workspace tokens can configure policy but cannot execute a
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
- `secret.broker.requested`
- `secret.broker.completed`
- `secret.broker.failed`

Events include account, workspace, session, actor, source, secret identifier,
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
- Transparent `egress` returns `409` when Platinum is unavailable.
- An unenforceable transparent policy returns `400`.
- Two egress secrets that claim one `(host, header)` pair return `409` with
  `code: 'secret_boundary_destination_conflict'`.
- Two egress secrets on one host with different headers are accepted. Both are
  injected.
- A granted transparent secret blocks session startup on unsupported providers.
- Plain HTTP to a policy host is refused by the proxy, not by Kortix.
- A response that would echo an egress secret is killed by the proxy.
- A failed push to a running sandbox returns `delivery_sync.ok === false`. The
  save still succeeds.
- A stale, expired, or revoked session handle returns `409`.
- A host, method, or path mismatch returns `403`.
- A connector binding blocks secret deletion and incompatible strategy changes
  with `409`.
- A connector cannot combine a bound workspace secret with a stored credential.
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

Platinum network substitution also requires a live provider test. That test
must prove injection, sandbox non-disclosure, rotation, revocation, and echo
blocking. Prove injection with the two-probe recipe above. A single probe
against an echo endpoint cannot distinguish a working boundary from a dead one.

## Related specifications

- [`2026-07-26-agent-scoped-secret-injection.md`](./specs/2026-07-26-agent-scoped-secret-injection.md)
- [`2026-07-26-secret-delivery-policy.md`](./specs/2026-07-26-secret-delivery-policy.md)
