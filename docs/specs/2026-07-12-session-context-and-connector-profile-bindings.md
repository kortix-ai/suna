# Session Context and Connector-Profile Bindings

**Status:** Phase 1 implemented; connector-profile binding phases specified.

**Audience:** Kortix API/SDK/runtime owners and wrapper-backend authors such as VEYRIS.

## 1. Decision

The project repository remains the source of truth for an agent's behavior and
governance: agents, skills, connector definitions, policies and sandbox
configuration. Runtime identity is a different concern and is bound durably to
the Kortix session.

The resulting split is:

- **Project/manifest:** what the agent is and which logical capabilities it may
  use.
- **Connector profile:** whose concrete account/credential backs one logical
  capability.
- **Session binding:** which allowed profile this run uses.
- **Runtime context:** small, non-secret descriptive values the agent may read.

No public API accepts arbitrary environment variables or raw OpenCode/MCP
configuration. Third-party credentials remain server-side.

## 2. Threat model and invariants

A wrapper's end user may be untrusted and may fully control prompt input. The
sandbox and model output therefore cannot be an authorization source.

The implementation MUST preserve these invariants:

1. A session cannot select a connector profile owned by another project,
   account, member or external subject unless the caller has an explicit
   administrative binding capability.
2. A model-supplied workspace/customer id is never trusted. Authorization is
   derived from a server-validated capability/profile binding.
3. Connector credentials are decrypted only in the Executor control plane and
   never injected into the sandbox.
4. Manifest agent grants authorize logical connector aliases. A session
   binding may only narrow that set; it cannot add a connector the agent was not
   granted.
5. Omitted session bindings preserve existing manifest/project defaults.
6. Binding and profile revocation take effect on the next Executor request,
   without sandbox restart or token remint.
7. Runtime context contains only bounded JSON scalars and is never security
   significant.

## 3. Phase 1: durable non-secret runtime context

### Public contract

`POST /v1/projects/:projectId/sessions` accepts:

```json
{
  "agent_name": "veyris",
  "runtime_context": {
    "workspace_id": "org_123",
    "wrapper.locale": "de",
    "licensed": true
  }
}
```

`runtime_context` is optional and has these constraints:

- at most 64 entries;
- at most 16 KiB after UTF-8 JSON serialization;
- values are only string, finite number, boolean or null;
- keys start with a lower-case letter, contain only lower-case letters,
  numbers, `.`, `-`, `_`, and are at most 64 characters;
- credential-like key segments (`token`, `secret`, `password`, API/private
  keys, `authorization`, `cookie`) are rejected;
- nested objects, arrays and unknown session-create escape hatches are rejected.

The lower-case semantic key space makes names such as `PATH`, `NODE_OPTIONS`,
`KORTIX_TOKEN` and `OPENCODE_CONFIG_CONTENT` impossible. More importantly,
individual keys are never expanded into environment variables.

### Persistence and runtime materialization

`kortix.project_session_runtime_contexts` stores one validated JSON object per
session. It is separate from `project_sessions.metadata`, because that metadata
has a user-editable patch surface and must not mutate runtime identity.

At every initial provision, cold reallocation and replacement restart, the API
loads the row and generates exactly one variable:

```text
KORTIX_SESSION_CONTEXT={"workspace_id":"org_123","wrapper.locale":"de","licensed":true}
```

Trusted internal `extraEnvVars` cannot override or synthesize that variable.
Absence of a context row means the variable is absent, preserving legacy
sessions byte-for-byte.

Runtime context is descriptive. VEYRIS may use it to tell the agent which
workspace name/locale it is serving, but its database API MUST authorize from a
capability token/profile, not `workspace_id` in this JSON.

## 4. Target connector model

Today one `executor_connectors` row conflates a logical connector definition
with one project-shared credential. The target separates them.

### `executor_connectors` (definition; existing)

Manifest-materialized logical capability: slug/alias, provider, remote schema,
action catalog and policies. Example aliases are `veyris`, `email`, `gmail`.

### `executor_connection_profiles` (new in Phase 2)

One concrete identity behind a connector definition:

| Field | Meaning |
|---|---|
| `profile_id` | UUID primary key |
| `account_id`, `project_id` | hard tenant scope |
| `connector_id` | logical connector definition |
| `owner_type` | `project`, `agent`, `member`, `subject`, `external` |
| `owner_id` | owner within the declared type, nullable only for project profiles |
| `label`, `status`, `metadata` | non-secret management data |
| timestamps | audit/lifecycle |

Credentials attach to `profile_id`, not directly to the connector. Values stay
encrypted and server-side.

### `project_session_connector_bindings` (new in Phase 2)

| Field | Meaning |
|---|---|
| `session_id` | durable Kortix session |
| `connector_alias` | manifest/logical name used by the agent |
| `profile_id` | concrete profile selected for the run |
| `source` | `request` or `default` |
| timestamps | audit/lifecycle |

Unique `(session_id, connector_alias)`. Foreign keys/constraints must prove
that session, connector and profile share the same project/account. A profile
cannot be deleted while bound; revocation changes status and immediately makes
Executor calls fail closed.

## 5. Resolution algorithm

The Executor principal already includes `projectId`, `sessionId` and the
manifest-resolved `agentGrant`.

For catalog and call:

1. Load the logical connector definition in the token's project.
2. Require the logical alias in `agentGrant.connectors` (or explicit `all`).
3. Load the session binding for that alias.
4. If present, validate profile project/account, status and owner policy.
5. If absent, resolve the connector's migrated default project profile.
6. Resolve/decrypt that profile's credential server-side.
7. Apply existing project/connector action policy, approval and audit logic.
8. Attribute the execution to session, subject/member/profile.

Catalog caching must include session id and a binding/profile revision. A
project-wide catalog cache is insufficient after profiles become dynamic.

## 6. Public binding API and authorization

Phase 2 extends session create with a typed structure, never raw MCP JSON:

```json
{
  "connector_bindings": {
    "veyris": { "profile_id": "..." },
    "email": { "profile_id": "..." }
  }
}
```

Initial rollout requires a dedicated `project.session.bindings.write`
capability held by project managers and operator service accounts. A later
self-service path may allow an interactive member/subject to select only a
profile they own. The floor `project.session.start` permission alone is not
enough to select arbitrary project profiles.

An idempotent create replay with the same idempotency key but different binding
payload must return a conflict. Binding rows are written before provisioning.

## 7. MCP strategy

Kortix does not inject an arbitrary remote MCP server into OpenCode per session.
Remote MCP is already an Executor connector provider, where URL validation,
credential resolution, policy, approval and audit run server-side.

If an OpenCode MCP face is desired, enable the existing stable
`kortix-executor` meta-tool server. It exposes catalog/discover/describe/call
and still routes every operation through the session-aware Executor. The CLI
remains the primary path.

This avoids:

- secrets in MCP child-process environment;
- arbitrary config overriding the sealed agent config;
- SSRF from caller-supplied server URLs;
- stale configuration after warm resume;
- a second, unaudited connector execution plane.

## 8. VEYRIS end-to-end flow

One Kortix project holds the VEYRIS agent configuration. Each VEYRIS Better
Auth organization maps to a VEYRIS workspace and receives its own profiles.

Provisioning:

1. VEYRIS creates/loads its organization workspace.
2. VEYRIS ensures a `veyris` capability profile for that workspace. The
   encrypted credential is a short-lived/revocable VEYRIS API capability.
3. VEYRIS ensures one AgentMail/email profile for the workspace and stores the
   returned unique address in VEYRIS workspace metadata.
4. VEYRIS creates a Kortix session with the two profile ids plus optional
   non-secret `runtime_context` (`workspace_id`, locale, display hints).
5. Kortix atomically persists the session bindings before runtime provision.
6. The agent invokes `veyris` or `email`; Executor resolves only the profiles
   bound to that session.

The VEYRIS capability should assert at least:

- audience (`veyris-workspace-api`);
- VEYRIS workspace/organization id;
- Kortix project id and session id;
- allowed operations/scopes;
- expiry, issued-at and unique `jti`/nonce.

VEYRIS verifies those claims on every request and scopes every database query
from the verified workspace claim. A request body/query claiming another
workspace is ignored or rejected. The Kortix project never receives direct
Neon credentials.

## 9. Email/channel migration

AgentMail already supports multiple project installs, but each install is
currently materialized as a separate connector slug. Migration is staged:

1. Backfill one default project profile for every existing connector and point
   existing credentials at it. Executor dual-reads legacy credentials while the
   migration flag is enabled.
2. Treat existing AgentMail slugs as legacy logical connectors with their own
   default profiles; behavior remains unchanged.
3. Create one logical `email` definition and migrate each inbox/install into an
   email profile.
4. Write explicit session bindings for inbound email sessions from their inbox
   id. Direct sessions require a selected/default profile.
5. After telemetry proves no legacy reads, remove connector-level credential
   resolution and legacy per-install connector rows.

There is no silent promotion of personal OAuth credentials to a shared profile.

## 10. Compatibility and rollout

- Phase 1 is additive. Sessions without `runtime_context` produce no new row or
  environment variable.
- Existing snake_case fields and the route's prior camelCase aliases remain
  supported; other unknown fields are rejected by the authoritative schema.
- Queued lifecycle commands retain the original typed create body, including
  context and future bindings.
- Phase 2 backfills default profiles before switching reads. Omitted bindings
  have exactly today's shared-project behavior.
- Existing session PAT claims do not need profile ids. Binding resolution uses
  the already-enforced `sessionId`, permitting live revoke/rebind.
- In-place provider restart keeps its existing environment. Since credentials
  are resolved server-side, profile changes still take effect immediately;
  non-secret context changes are not exposed as a mutation in Phase 1.

## 11. Required verification for Phase 2

- two sessions bound to two profiles see/call only their own profile;
- cross-project/account/subject profile selection is rejected;
- manifest grant and session binding intersect (neither widens the other);
- omitted binding resolves the legacy default;
- revoke takes effect during a running session;
- idempotent replay cannot swap bindings;
- AgentMail inbox A cannot send/read as inbox B;
- cold provision and restart preserve bindings/context;
- no profile credential or VEYRIS token appears in sandbox env, logs,
  transcript, OpenAPI examples or API responses;
- real SDK -> API -> Executor E2E covers create, readiness, call, reload and
  tenant isolation.

## 12. Explicit non-goals of Phase 1

- no raw session environment input;
- no dynamic OpenCode configuration;
- no dynamic third-party MCP injection;
- no connector credential/profile behavior change;
- no claim that descriptive `runtime_context.workspace_id` is an authorization
  boundary.
