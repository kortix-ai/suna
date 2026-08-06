# Secret delivery control plane

**Status:** Implemented for runtime, managed consumers, and policy-bound HTTPS calls
**Not implemented:** Transparent network-boundary substitution

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
| `broker` | `connector` | Nothing | Kortix resolves connector credentials server-side |
| `broker` | `executor` | Nothing | Kortix resolves automation and channel credentials server-side |
| `broker` | `http_broker` | Opaque session handle | Kortix makes one policy-bound HTTPS request |
| `broker` | `git_proxy` | Nothing | Git uses its separate encrypted credential path |
| `egress` | `network` | Opaque placeholder | Unavailable and rejected with `409` |
| `denied` | none | Nothing | Stored but disabled |

`runtime` is the only strategy that sends plaintext to a sandbox. No managed
strategy silently falls back to `runtime`.

Generic `git_proxy` policy updates remain unavailable. Git authorization uses a
separate typed API and credential store. It applies the same server-only and
audit requirements.

Transparent `egress` remains unavailable because the enabled sandbox providers
do not yet expose one verified, provider-independent substitution contract.
Kortix rejects it instead of presenting a false security boundary.

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

The CLI exposes this path through:

```bash
kortix secrets delivery API_KEY broker \
  --consumer http-broker \
  --allow-host api.example.com \
  --method POST \
  --path /v1/ \
  --header Authorization \
  --template 'Bearer {{secret}}'

kortix secrets call API_KEY https://api.example.com/v1/resource \
  --method POST \
  --body '{"input":"value"}'
```

## Product surfaces

The API, SDK, CLI, and web UI expose `strategy`, `consumer`,
`delivery_status`, and `requires_rotation`. Values remain write-only.

The web editor provides these choices:

- **Readable in sandbox** for `runtime` and `sandbox`;
- **LLM gateway** for provider requests;
- **Connector** for connector authorization;
- **Automation** for Executor actions and channels;
- **HTTPS broker** for a policy-bound request;
- **Stored but disabled** for `denied`.

The UI shows transparent network delivery as unavailable. It does not imply
that an opaque handle provides network-boundary substitution.

The CLI supports the same available consumers through `kortix secrets
delivery`. `kortix secrets ls --json` returns the stored delivery metadata.

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
- Transparent `egress` returns `409`.
- A stale, expired, or revoked session handle returns `409`.
- A host, method, or path mismatch returns `403`.
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

Transparent network substitution needs a separate provider-adapter design,
live exfiltration tests, and fail-closed capability detection before Kortix can
enable `egress`.

## Related specifications

- [`2026-07-26-agent-scoped-secret-injection.md`](./specs/2026-07-26-agent-scoped-secret-injection.md)
- [`2026-07-26-secret-delivery-policy.md`](./specs/2026-07-26-secret-delivery-policy.md)
