# Secret delivery control plane

**Status:** Approved design, implementation in progress  
**Scope:** Project secrets, sessions, LLM gateway, Executor, Git, HTTP egress, audit

## Purpose

Kortix must control where each secret can be used. Storing a value safely is
not sufficient. The delivery path must also prevent an agent from reading or
redirecting the value.

The target contract is:

> A secret reaches only its approved consumer through its approved delivery
> path. Every decision and use produces a central audit event without the
> secret value.

The product uses one term: **Secret**. Environment variables are one possible
runtime delivery mechanism. They are not the storage model.

## Security model

Three independent decisions control access.

1. **Authorization** selects which secret identifiers the principal may use.
   Kortix intersects the project policy, agent grant, and session allowlist.
2. **Consumer** identifies the service that needs the secret. Initial consumers
   are sandbox runtime, LLM gateway, Executor, Git proxy, and HTTP broker.
3. **Delivery** defines how the consumer receives or uses the value.

Connector and LLM are consumers. They are not delivery strategies.

| Strategy | Sandbox receives | Use |
| --- | --- | --- |
| `runtime` | Plaintext value | A local process must read the value |
| `broker` | No plaintext | A Kortix service calls the upstream service |
| `egress` | Opaque placeholder | A network boundary replaces the placeholder |
| `denied` | Nothing | The value is stored but disabled |

The strictness order is `runtime < egress < broker < denied`. During request
resolution, a lower layer can tighten a decision. It cannot weaken a stricter
decision. An authorized person can change the stored strategy. Restoring
`runtime` after a stricter strategy requires a new secret value first.

## System boundaries

```text
Web / CLI / API
        |
        v
Secret policy service
  - authorize principal
  - select consumer
  - resolve delivery
  - decrypt only when allowed
  - record decision
        |
        +--> sandbox runtime: explicit plaintext delivery
        +--> LLM gateway: server-side provider request
        +--> Executor: server-side connector request
        +--> Git proxy: server-side Git authorization
        +--> HTTP broker: allowlisted upstream request
        +--> egress adapter: boundary placeholder replacement
```

Only the secret policy service may decrypt a project secret for use. Storage,
routes, and UI code can read metadata without decrypting the value. CI will
enforce this boundary with an import rule after existing consumers migrate.

## Required behavior

### Authorization

- A session receives no secret that is outside its immutable allowlist.
- An agent receives no secret that is outside its agent grant.
- An empty session allowlist means zero project secrets.
- Missing policy data fails closed for `broker`, `egress`, and `denied`.
- Platform-reserved `KORTIX_*` names never come from project secret rows.

### Delivery

- `runtime` is the only strategy that can place plaintext in a sandbox.
- `broker` remains unavailable until its named server path exists.
- `egress` remains unavailable until its provider adapter passes live tests.
- `denied` blocks every consumer.
- No strategy silently falls back to `runtime`.
- A change from `runtime` requires rotation because an existing sandbox may
  retain the old value.

### Network delivery

The first egress implementation targets HTTPS header credentials. Each policy
must contain at least one approved host. Optional method and path restrictions
further narrow use. Redirects require a new policy match. Private, loopback,
link-local, metadata, and DNS-rebinding targets are blocked.

Daytona now supports opaque placeholders, HTTPS-header substitution, host
allowlists, response scrubbing, and secret updates. It does not substitute in
HTTP, request bodies, query parameters, or transformed values. Kortix must
therefore keep a provider-independent broker for unsupported credentials.

E2B exposes outbound network controls. Its documented public API does not yet
prove equivalent secret substitution. E2B egress delivery remains disabled
until a live capability test passes.

Provider-native delivery does not replace Kortix audit. Kortix must record the
policy decision and upstream result for each managed use.

## Agent-visible identity

The sandbox exposes one Kortix bearer: `KORTIX_TOKEN`. The token identifies the
project session and carries the current agent grant. LLM, Executor, Git, and
broker routes use the same bearer.

Machine identity must stay outside the guest. A root agent can read any token
stored by a daemon inside the same guest. Provider control-plane credentials
therefore belong in a host-side proxy, mTLS channel, or provider API.

## API and UI contract

Every secret view exposes metadata, never the value:

- `identifier`
- `name`
- `strategy`
- `consumer`
- `status`
- `egress_policy` when applicable
- `last_rotated_at`
- `last_used_at`
- `requires_rotation`

UI labels use direct language:

| Strategy | Label | Warning |
| --- | --- | --- |
| `broker` | Used through Kortix | The value stays on Kortix services |
| `egress` | Sent only to approved hosts | HTTPS header use only |
| `runtime` | Readable in sandbox | Agent code can read and copy the value |
| `denied` | Stored but disabled | No consumer can use the value |

After phase 6, new generic secrets default to `denied`. Known managed consumers
default to `broker`. Existing secrets remain `runtime` until an explicit
migration.

## Central audit contract

The central `audit_events` log records administration, policy decisions, and
managed use. Every event includes:

- `account_id`, `project_id`, and `session_id` when available
- actor type, actor identifier, and source
- action, resource type, and secret identifier
- requested consumer and resolved strategy
- outcome and denial reason
- request, trace, and correlation identifiers
- upstream host, HTTP method, status, and duration when applicable

Audit data never contains plaintext values, encrypted envelopes, provider
tokens, placeholders, authorization headers, request bodies, or response
bodies.

Required actions include `secret.created`, `secret.updated`, `secret.deleted`,
`secret.strategy.changed`, `secret.access.allowed`, `secret.access.denied`, and
`secret.used`.

A secret configuration mutation and its semantic audit event commit in one
database transaction. Webhook dispatch starts only after that transaction
commits. An audit insert failure rolls back the mutation.

## Current implementation

The first implementation slice provides strategy metadata through the API and
SDK. It supports `runtime` and `denied`. It rejects `broker` and `egress` with a
typed `409` until their adapters exist. Only authorized human and service
account principals can change a strategy. Restoring `runtime` requires a value
rotation. Secret create, update, delete, and strategy changes produce atomic,
metadata-only semantic audit events.

This slice does not include broker adapters, egress adapters, the strategy
editor UI, per-use audit events, or the default migration. The delivery phases
below define that remaining work.

## Delivery phases

1. **Close current gaps.** Fail closed for incomplete strategies. Centralize
   server reads. Enforce `denied` for every consumer. Audit secret changes.
2. **Expose the policy contract.** Add strategy and consumer metadata to the
   API, SDK, CLI, and UI. Keep unavailable strategies disabled.
3. **Broker managed consumers.** Route LLM, connector, and Git credentials
   through their existing server services.
4. **Add the generic HTTP broker.** Enforce host, method, path, redirect, SSRF,
   rate, and response-scrubbing rules.
5. **Add transparent egress.** Implement provider adapters and require live
   capability tests. Never downgrade on unsupported providers.
6. **Migrate defaults.** Classify existing secrets, rotate exposed values, and
   change new-secret defaults after broker coverage is complete.

Each phase must keep `main` deployable. Each new capability needs unit tests,
live API tests, sandbox exfiltration tests, audit assertions, and negative tests.

## Acceptance tests

- `runtime`: a selected secret is readable in a sandbox.
- `denied`: the name and value are absent from the sandbox and every broker.
- `broker`: the managed call succeeds and the sandbox cannot read the value.
- `egress`: an allowed HTTPS header call succeeds with a placeholder.
- `egress`: wrong host, method, path, redirect, body, query, and transformed
  placeholder do not reveal or transmit the value.
- Rotation changes managed use without returning the new value.
- Each attempt creates one queryable audit event with no sensitive fields.
- Daytona, E2B, Platinum, and local adapters fail closed when unsupported.

## References

- [Daytona secrets](https://www.daytona.io/docs/en/secrets/)
- [Daytona network limits](https://www.daytona.io/docs/en/network-limits/)
- [E2B sandbox creation API](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox)
- [`2026-07-26-agent-scoped-secret-injection.md`](./specs/2026-07-26-agent-scoped-secret-injection.md)
- [`2026-07-26-secret-delivery-policy.md`](./specs/2026-07-26-secret-delivery-policy.md)
