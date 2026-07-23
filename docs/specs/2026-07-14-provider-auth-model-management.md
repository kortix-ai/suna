# Provider authentication and model management

Status: proposed for approval
Date: 2026-07-14
Scope: ACP-first multi-harness work in PR #4510
Supersedes: the provider/auth/model UX and default-resolution decisions in
`2026-07-12-multi-harness-auth-model-session-ux.md`,
`sdk-model-system-redesign.md`, and `default-model-resolution.md` where they
conflict with this document.

## 1. Product decision

The product asks one question:

> How should this agent run?

Users should not have to compose a provider, secret, endpoint, harness route,
catalog source, model visibility preference, and fallback policy before they can
start a session.

The system has five distinct concepts, but the default UI reveals only the ones
needed for the current agent:

1. **Agent**: the logical Kortix identity selected by the user.
2. **Harness**: Claude Code, Codex, OpenCode, or Pi, resolved from the agent's
   runtime profile in `kortix.yaml`.
3. **Connection**: one usable way for a harness to authenticate to a model
   service, such as a Claude subscription or Anthropic API key.
4. **Model selection**: harness default, managed automatic routing, an
   authoritative discovered model, or an explicit custom model ID.
5. **Execution route**: the immutable, resolved agent + harness + connection +
   model policy stored on a session.

Provider catalog management, credential management, and model visibility are
not peer tabs. The current `Connected / Add provider / Models` modal is removed.

## 2. Non-negotiable boundaries

1. `kortix.yaml` v3 remains the source of truth for logical agents, runtime
   profiles, native agent IDs, config directories, governance, and the project
   default agent.
2. Secrets and OAuth/subscription material never live in `kortix.yaml`. They are
   encrypted platform records referenced by opaque connection IDs.
3. Harness-native files remain the source of truth for harness behavior and the
   harness's native model default. Kortix does not translate all harness configs
   into a universal provider file.
4. ACP is the only conversation protocol. Authentication and launch
   configuration are control-plane concerns because ACP does not define them.
5. `@kortix/sdk` owns every connection, capability, catalog, resolution, and
   session API. Web, mobile, CLI, Slack, schedules, and webhooks are thin
   consumers of the same contract.
6. A catalog is optional discovery metadata. It is never proof of entitlement
   and, by itself, is never a reason a native-default session cannot start.
7. Subscription model lists are owned by the authenticated Claude Code or Codex
   runtime. Kortix never fabricates them from models.dev.
8. The agent and harness are immutable after session creation. A model can
   change live only if the active ACP server advertises a writable model option.
9. A valid harness default does not require the user to select a model.
10. PR #4510 remains isolated and unmerged until the user explicitly authorizes
    a merge.

## 3. Canonical terminology

### 3.1 Provider

The organization serving an API or subscription: Kortix, Anthropic, OpenAI, or
a user-defined service. A provider is descriptive metadata, not a credential.

### 3.2 Endpoint

The protocol and base URL used for model requests. Known providers have managed
defaults. Custom endpoints specify `openai-compatible` or
`anthropic-compatible`, a base URL, and optional headers supported by the
connection type.

### 3.3 Credential

Secret material such as an API key, Claude setup token, or Codex refreshable
authorization bundle. Credential values are write-only. Clients receive status,
revision, expiry when known, and redacted diagnostics only.

### 3.4 Connection

A first-class project record combining provider metadata, endpoint, auth method,
and credential reference. Examples:

- `Kortix managed`
- `Claude subscription`
- `Anthropic production key`
- `ChatGPT subscription`
- `OpenAI development key`
- `Local vLLM`

Connections have stable IDs and slugs. More than one connection of the same type
may coexist.

### 3.5 Model

A connection-qualified model ID. `gpt-5` on two custom endpoints is two distinct
choices. The canonical identity is `(connectionId, modelId)`, not a globally
unique `provider/model` string.

### 3.6 Execution route

The fully resolved launch contract:

```ts
type EffectiveExecutionRoute = {
  agentName: string;
  runtimeProfile: string;
  harness: "claude" | "codex" | "opencode" | "pi";
  nativeAgent: string | null;
  connectionId: string;
  connectionKind: string;
  model:
    | { mode: "harness-default" }
    | { mode: "managed-auto" }
    | { mode: "explicit"; modelId: string };
  provenance: {
    connection:
      | "session"
      | "project-harness-default"
      | "managed-fallback"
      | "only-compatible";
    model: "session" | "native-config" | "connection-default" | "managed-auto";
  };
};
```

This binding is persisted on session creation and reused on restart,
reprovision, transcript export, share, and headless completion delivery.

## 4. Supported connection types

| User-facing connection      | Auth material                                         | Primary harness support                   | Catalog authority                       |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| Kortix managed              | sandbox-scoped Kortix credential                      | adapters verified by capability matrix    | Kortix gateway                          |
| Claude subscription         | `CLAUDE_CODE_OAUTH_TOKEN`                             | Claude Code                               | Claude Code when exposed                |
| Anthropic API               | Anthropic API key/auth token                          | adapters verified as Anthropic-compatible | models.dev plus optional live discovery |
| ChatGPT subscription        | refreshable Codex authorization bundle                | Codex                                     | Codex when exposed                      |
| OpenAI API                  | OpenAI API key                                        | adapters verified as OpenAI-compatible    | models.dev plus optional live discovery |
| Custom OpenAI-compatible    | base URL, optional key, declared models               | capability-declared adapters              | endpoint discovery plus manual IDs      |
| Custom Anthropic-compatible | base URL, optional key, declared models               | capability-declared adapters              | endpoint discovery plus manual IDs      |
| Harness-native              | files already present in the runtime config directory | owning runtime profile                    | harness ACP options/native config       |

Compatibility is returned by adapter capability data and tested in real
sandboxes. The UI must not hard-code that every OpenAI-compatible endpoint works
with every harness merely because the protocol name looks compatible.

Claude subscription and Anthropic API are always separate connections. ChatGPT
subscription and OpenAI API are always separate connections.

## 5. User experience

### 5.1 Primary surface: Models

Replace the three-tab provider modal with one page titled **Models** and the
subtitle **Connect model services and choose what each agent runtime uses.**

The entire working state is visible on one page:

1. **Agent runtimes**: one compact row for each configured harness. Every row
   shows the connection and model policy it currently uses and contains the
   direct `Change` or `Connect` control. There is no separate routing page,
   disclosure, matrix, or advanced mode.
2. **Connections**: simple rows for connected methods with status and which
   harnesses currently use them.
3. **Connect**: one primary page action that opens the connection catalog.

There are no top-level tabs and no browser-local model visibility manager.
Models are displayed in the selected harness row, inside a connection's details,
or in the composer for the selected agent.

An agent-runtime row reads like:

```text
Claude Code                         Connected
Claude subscription · Harness default       Change
```

Changing the connection uses an inline selector containing only compatible,
ready connections. A missing connection changes the row action to `Connect`.
The user never has to open an advanced surface to understand or change the
effective route.

Each connection row shows:

- display name and auth type;
- `Connected`, `Needs attention`, `Checking`, or `Unavailable`;
- `Used by Claude Code`, `Used by Codex`, and similar concise labels;
- `Manage`, which opens test, rotate/reconnect, model discovery, and disconnect;
- never `0 models` for a subscription whose catalog is simply not exposed.

For a subscription without an authoritative list, show:

> Models are managed by Claude Code.

or:

> Models are managed by Codex.

### 5.2 Connect flow

The catalog is grouped by intent:

1. **Use a subscription**: Claude Code, ChatGPT/Codex.
2. **Use an API key**: Anthropic, OpenAI, other known providers.
3. **Use a custom endpoint**: advanced OpenAI-compatible or
   Anthropic-compatible setup.

The flow is:

```text
choose method -> authenticate/configure -> verify -> choose compatible harness use -> done
```

When it is the first ready connection for a harness, it becomes that harness's
project default. Adding a later connection never silently replaces a valid
default; the final step offers an explicit **Use for ...** choice.

Custom endpoint setup asks for:

- name;
- compatibility protocol;
- base URL;
- authentication mode and key when required;
- optional live discovery;
- one or more manual model IDs when discovery is unavailable;
- one default model when the endpoint cannot choose a default itself.

Multiple custom endpoints and multiple models per endpoint are supported.

### 5.3 Agent and model selector in the composer

The composer first selects a logical agent. The selected row shows the agent
name and its harness badge. That selection drives every subsequent option.

The model control then shows only choices valid for the resolved harness and
connection:

1. **Harness default** for Claude Code, Codex, Pi, or a natively configured
   OpenCode runtime;
2. **Automatic** for the Kortix managed gateway;
3. authoritative discovered/preset models;
4. **Custom model ID...** only when the adapter accepts a launch override.

The control may show a secondary line such as `via Claude subscription` or
`via Kortix managed`. It never asks the user to understand internal route names
such as `managed_gateway` or `native_config`.

The send button is enabled when authentication is ready and the selected route
has a valid default. An empty optional catalog does not disable it.

If authentication is missing, the composer shows one direct action, such as
**Connect Claude Code**. If a custom endpoint truly requires a model and has no
default, it shows **Choose a model for Local vLLM**. Generic `No models available
for this session yet` is removed.

On existing sessions, agent and harness are read-only. Connection/model changes
either use an advertised live ACP option or clearly offer **Start a new session
with this model**.

### 5.4 Connection error behavior

- Expired/revoked subscription: `Reconnect Claude Code` or `Reconnect Codex`.
- Invalid API key: identify the connection by its user-facing name.
- Endpoint unreachable: retain configuration, show the last check and retry.
- Model rejected upstream: show harness, connection, model ID, and redacted
  upstream error.
- Disconnecting an active default requires selecting a replacement or accepting
  the deterministic fallback preview.
- Credential rotation never kills a busy turn. The next safe restart applies it.

## 6. Model ownership and defaults

There is no universal model default across incompatible harnesses.

| Scope                    | Canonical owner                               | Meaning                                           |
| ------------------------ | --------------------------------------------- | ------------------------------------------------- |
| Account                  | UI preference only, or managed-gateway policy | never silently forces a model into every harness  |
| Project + harness        | control-plane connection route                | which connection that harness uses by default     |
| Runtime/native agent     | harness-native config                         | the harness's default model and provider behavior |
| Trigger/channel/schedule | explicit launch selection when configured     | reproducible override for that run                |
| Session                  | persisted execution route                     | immutable launch choice and provenance            |
| Active ACP session       | ACP config option when writable               | supported live change only                        |

`kortix.yaml` v3 does not contain credential values or a universal `model`
field. Its agent points to a runtime profile and optional native agent ID. The
native runtime config owns native model defaults.

Managed gateway defaults and fallback policies remain a separate advanced
gateway concern. They apply only when the resolved connection is Kortix managed;
they are not mixed into subscription or direct API model selection.

Browser localStorage may cache presentation state, but it is never an execution
authority for project, agent, trigger, or session defaults.

## 7. Resolution algorithm

The API and every headless caller use one resolver:

```text
logical agent
  -> compiled kortix.yaml runtime profile
  -> harness and native agent
  -> compatible ready connections
  -> effective connection
  -> effective model policy
  -> adapter-specific launch translation
  -> immutable session execution route
```

### 7.1 Connection resolution

1. A valid explicit session/trigger connection selection.
2. The valid project default connection for the harness.
3. Kortix managed when ready and verified compatible with that adapter.
4. The only remaining compatible ready connection.
5. Otherwise block with `connection_selection_required` or
   `connection_required` and return the exact compatible choices.

The first connection flow creates the project harness default, so normal users
do not encounter ambiguity. No route is selected by environment-variable order.

### 7.2 Model resolution

1. A valid explicit launch model, qualified by connection.
2. The connection's configured default model when that endpoint requires one.
3. `managed-auto` when using Kortix managed.
4. The native agent/runtime default, expressed by omitting a launch override.
5. Otherwise block with `model_selection_required`.

Catalog availability is not a step in this algorithm. It only supplies optional
choices for step 1.

### 7.3 Launch translation

The neutral route is translated at the adapter boundary only:

- Claude Code: selected OAuth/API/base URL environment and optional native model
  override; omit the model for harness default.
- Codex: selected auth/config provider and optional model override; omit the
  model for harness default.
- OpenCode: generated launch overlay pointing at the chosen connection/model
  without changing the project's native files.
- Pi: generated launch overlay or advertised ACP config option without changing
  the project's native files.

No model or provider field is added to ACP `session/prompt`.

## 8. Canonical persisted data

### 8.1 Connection record

```ts
type ModelConnection = {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  providerKind: "kortix" | "anthropic" | "openai" | "custom";
  authKind:
    | "managed"
    | "subscription"
    | "api-key"
    | "bearer"
    | "none"
    | "native-config";
  protocol: "kortix" | "anthropic" | "openai-compatible" | "harness-native";
  baseUrl: string | null;
  credentialBundleRef: string | null;
  status: "checking" | "ready" | "needs-attention" | "unavailable";
  statusReason: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

The API never returns `credentialBundleRef` or credential values to hosts. It is
shown here as an internal relationship, not a public response field.

### 8.2 Harness route record

```ts
type ProjectHarnessRoute = {
  projectId: string;
  harness: Harness;
  connectionId: string;
  updatedBy: string;
  updatedAt: string;
};
```

### 8.3 Model descriptor

```ts
type ConnectionModel = {
  connectionId: string;
  modelId: string;
  name: string;
  source: "managed" | "harness" | "live-discovery" | "models-dev" | "manual";
  availability: "available" | "unknown" | "unavailable";
  isConnectionDefault: boolean;
};
```

`models.dev` entries have `availability: unknown` until a real provider or
harness confirms them.

### 8.4 Session launch selection

```ts
type SessionModelSelection =
  | { mode: "default" }
  | { mode: "explicit"; connectionId: string; modelId: string };
```

The unresolved request and resolved execution route are both persisted so the
system can explain what happened and reproduce it.

## 9. API and SDK contract

The API exposes one capability document rather than forcing clients to join
secrets, billing, catalogs, agents, and adapter assumptions:

```ts
type AgentExecutionOptions = {
  agent: LogicalAgent;
  harness: { id: Harness; label: string };
  connections: Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    compatible: boolean;
    isProjectDefault: boolean;
  }>;
  route: {
    resolvedConnectionId: string | null;
    source: string | null;
  };
  models: {
    defaultMode:
      "harness-default" | "managed-auto" | "connection-default" | null;
    choices: ConnectionModel[];
    customIdAllowed: boolean;
    liveChange: boolean;
    catalogState: "available" | "not-exposed" | "loading" | "error";
  };
  canStart: boolean;
  blockers: Array<{ code: string; message: string; action: string | null }>;
  warnings: Array<{ code: string; message: string }>;
};
```

Required REST operations:

```text
GET    /projects/:id/model-connections
POST   /projects/:id/model-connections
GET    /projects/:id/model-connections/:connectionId
PATCH  /projects/:id/model-connections/:connectionId
DELETE /projects/:id/model-connections/:connectionId
POST   /projects/:id/model-connections/:connectionId/test
POST   /projects/:id/model-connections/:connectionId/discover-models
PUT    /projects/:id/harness-routes/:harness
GET    /projects/:id/execution-options?agent=<name>
POST   /projects/:id/execution-options/resolve
```

The SDK owns matching framework-free methods, project facades, query keys,
mutations, cache invalidation, React hooks, and public types. Example:

```ts
kortix.project(id).modelConnections.list();
kortix.project(id).modelConnections.connect(input);
kortix.project(id).modelConnections.test(connectionId);
kortix.project(id).modelConnections.disconnect(connectionId);
kortix.project(id).harnessRoutes.set({ harness, connectionId });
kortix.project(id).executionOptions({ agentName });
kortix.project(id).resolveExecution({ agentName, modelSelection });
kortix.project(id).createSession({ agentName, modelSelection });
```

Session creation runs the same resolver transactionally and stores the resolved
route. A stale UI preview can never bypass server validation.

## 10. Single compiler/launch entrypoint

`kortix.yaml` is the declarative project source of truth, but it intentionally
cannot contain encrypted credentials or live entitlement. The one execution
compiler therefore has explicit inputs:

```ts
compileExecutionPlan({
  manifest,
  agentName,
  projectConnections,
  projectHarnessRoutes,
  adapterCapabilities,
  managedEntitlement,
  launchSelection,
});
```

It returns either an `EffectiveExecutionRoute` plus adapter launch plan, or typed
blockers. API session creation, CLI, Slack, schedules, webhooks, mobile, and web
all call this entrypoint. No caller reimplements precedence.

## 11. Migration

Migration is idempotent and preserves existing working projects:

1. Create connection records for existing `CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, `CODEX_AUTH_JSON`,
   `OPENCODE_AUTH_JSON`, `OPENAI_API_KEY`, and `CODEX_API_KEY` secret bundles.
2. Convert `CUSTOM_LLM_PROTOCOL`, `CUSTOM_LLM_BASE_URL`,
   `CUSTOM_LLM_API_KEY`, `CUSTOM_LLM_MODEL_ID`, and `CUSTOM_LLM_NAME` into one
   `custom-legacy` connection and one manual model. Do not keep the singleton
   limitation for new writes.
3. Convert `project.metadata.harness_auth_routes` from auth-kind strings to
   concrete connection IDs. Preserve a valid existing choice.
4. Scope existing account/project model preferences to the Kortix managed route
   only. Do not apply them to subscription or native harness defaults.
5. Convert `project_sessions.metadata.opencode_model` into the neutral unresolved
   launch selection and resolved route when enough historical data exists.
6. Retain compatibility reads for one release window, dual-write only where a
   rollback requires it, then delete legacy writers and secret inference.
7. Remove localStorage model visibility/default state as execution authority.
   It may be discarded or retained solely as a local display preference.
8. Replace current provider tabs and host-local provider projection with SDK
   connection and execution-option hooks.

## 12. Acceptance matrix

### 12.1 Connection lifecycle

For every supported connection type:

- connect with a real credential or managed entitlement;
- verify status without exposing the secret;
- list and reload persisted metadata;
- make it a harness default;
- rotate/reconnect;
- handle invalid, expired, revoked, and unreachable states;
- disconnect with deterministic replacement behavior;
- prove logs, transcripts, browser state, audit payloads, and exports contain no
  secret values.

### 12.2 Harness matrix

| Harness     | Required live routes                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Claude Code | Claude subscription; Anthropic API; managed/custom routes only when adapter compatibility is proven         |
| Codex       | ChatGPT subscription including refresh; OpenAI API; managed/custom routes only when compatibility is proven |
| OpenCode    | Kortix managed; OpenAI API; Anthropic API; compatible custom endpoints; native config                       |
| Pi          | Kortix managed; supported API/custom routes; native config                                                  |

For every supported cell, run a real Daytona sandbox through ACP initialize,
new/load session, prompt, streamed response, tool call, completion, reconnect,
and transcript reload. Unsupported cells must be explicit capability decisions,
not missing UI options.

### 12.3 Model behavior

- native/default launch succeeds with no catalog and no explicit model;
- managed automatic routing succeeds and records the resolved managed model;
- authoritative preset reaches the adapter exactly;
- manual custom ID reaches the adapter exactly;
- rejected ID produces a useful connection-qualified error;
- changing agent discards incompatible stale choices;
- changing harness connection recomputes model options;
- subscription with no exposed catalog says `Models managed by ...`, never
  `0 models`;
- a true endpoint-without-default case blocks with one precise action;
- live model changes appear only when ACP advertises them;
- restart/new-session changes preserve the correct route and provenance.

### 12.4 Surface parity

- API black-box create/list/update/test/resolve plus persisted read-back;
- SDK transport, facade, React hook, cache invalidation, public export, and
  framework-free import-graph gates;
- real Chromium DOM and request assertions for connect, route, agent picker,
  default model, explicit model, errors, reload, desktop, and mobile widths;
- native mobile, CLI, Slack, schedules, webhooks, and channel bindings using the
  same resolver;
- clean starter project's first session for all four harnesses;
- migrated v2/OpenCode project and historical session compatibility.

## 13. Implementation plan

Every SDK phase starts with a failing test and ends with the SDK gates and an
explicit shippable status.

1. **Lock this specification** and mark conflicting older model/auth decisions
   superseded.
2. **Inventory and RED tests** for every current provider projection, secret
   inference, route kind, local model preference, no-model gate, and session
   payload producer.
3. **Persistence and migration** for connection records, credential bundles,
   harness routes, custom connection models, and neutral session routes.
4. **Pure resolver/compiler** implementing typed capability, connection, model,
   provenance, and blocker decisions with exhaustive table tests.
5. **API and SDK authority** for connection CRUD, verification, model discovery,
   execution options, resolution preview, session creation, and invalidation.
6. **Adapter launch integration** for Claude, Codex, OpenCode, and Pi, including
   auth isolation, custom endpoints, model translation, and redaction.
7. **Models UX** replacing the three-tab modal with the single-page runtime and
   connection layout plus focused connection catalog/detail modals.
8. **Composer/session UX** with harness-aware agent rows, valid defaults,
   connection-qualified models, direct recovery actions, and live/new-session
   behavior.
9. **All secondary surfaces**: mobile, CLI, Slack, schedules, webhooks, channels,
   transcripts, share/export, and restart/reprovision.
10. **Legacy deletion** after migration proof: singleton custom secrets,
    auth-kind routing, browser execution defaults, universal no-model gate, and
    host-local provider inference.
11. **Real E2E matrix** in the production sandbox image for all supported live
    connection/harness cells, plus browser and headless parity.
12. **PR hardening**: focused/full tests, secret scan, clean branch, current main
    merged into the feature branch if required, required checks green, PR open
    and mergeable but unmerged.

## 14. Completion definition

This work is complete only when:

1. A new project can connect and start Claude Code, Codex, OpenCode, and Pi
   without understanding provider-route internals.
2. Claude and Codex subscriptions work without a fabricated catalog or explicit
   model selection.
3. API keys and multiple custom endpoints/models are first-class connections.
4. Every caller resolves the same execution route through the SDK/API compiler.
5. No browser-local or host-specific logic controls execution.
6. Every supported real harness/auth/model cell has recorded sandbox and ACP
   evidence, and every unsupported cell is explicitly labeled.
7. The old OpenCode HTTP/API data model is absent from Kortix application
   surfaces; OpenCode remains only as an ACP harness.
8. PR #4510 is clean, pushed, open, checks green, mergeable, and still not merged.

No percentage estimate substitutes for this matrix. Missing live credentials or
third-party outages remain explicit unverified cells rather than assumed passes.
