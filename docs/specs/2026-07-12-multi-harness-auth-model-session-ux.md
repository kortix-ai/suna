# Multi-harness authentication, model selection, agents, and session UX

Status: approved execution specification
Date: 2026-07-12
Scope: ACP-first Kortix runtime in PR #4510 (`acp-harness-runtime-v2`)

## 1. Outcome

Kortix must start and operate a session through Claude Code, Codex, OpenCode, or
Pi without any client pretending those harnesses share one provider, model,
authentication, configuration, or event contract.

The user chooses a logical Kortix agent. That agent resolves through
`kortix.yaml` to exactly one runtime profile and harness. The harness determines
which authentication routes and model controls are valid. ACP remains the
lossless conversation protocol. Kortix owns launch-time configuration that ACP
does not expose.

Completion means all supported flows work through API, SDK, web, mobile, and
headless entry points, and the real harness matrix passes in a real sandbox.

## 2. Non-negotiable boundaries

1. `kortix.yaml` is the source of truth for logical agents, runtime routing,
   native config directories, governance, and the project default agent.
2. Harness-native files remain the source of truth for native providers,
   prompts, hooks, permissions, profiles, and behavior. Kortix does not compile
   them into a lowest-common-denominator agent file.
3. ACP is the only harness conversation protocol: initialize, new/load, prompt,
   updates, tools, permission requests, elicitation, configuration, and stop.
4. `@kortix/sdk` is the only application data/runtime authority. Hosts do not
   fetch the backend directly, import a harness SDK, or infer capabilities from
   names.
5. A model catalog is not authentication. A credential is not a model catalog.
   A subscription is not a vendor API key. A custom endpoint is not a vendor
   subscription.
6. No static catalog may be presented as subscription entitlement.
7. The selected logical agent and resolved harness are immutable for a Kortix
   session. Changing harness starts a new session.
8. A model change is live only when the active ACP server advertises a writable
   model config option. Otherwise it is a launch-time change and requires a new
   or explicitly restarted session.

## 3. Canonical concepts

```ts
type Harness = 'claude' | 'codex' | 'opencode' | 'pi'

type LogicalAgent = {
  name: string
  runtime: string
  harness: Harness
  nativeAgent: string | null
  enabled: boolean
}

type AuthKind =
  | 'kortix-managed'
  | 'claude-subscription'
  | 'chatgpt-subscription'
  | 'anthropic-api-key'
  | 'openai-api-key'
  | 'custom-openai-compatible'
  | 'custom-anthropic-compatible'
  | 'harness-native'

type ModelSelection =
  | { mode: 'default' }
  | { mode: 'preset'; modelId: string }
  | { mode: 'custom'; modelId: string }

type ComposerCapabilities = {
  agent: LogicalAgent
  auth: {
    compatible: AuthKind[]
    active: AuthKind | null
    ready: boolean
    reason: string | null
  }
  model: {
    policy: 'gateway-catalog' | 'harness-catalog' | 'launch-override'
    defaultAllowed: boolean
    customAllowed: boolean
    liveChange: boolean
    presets: Array<{ id: string; name: string; source: string }>
  }
  canStart: boolean
  blockingReason: string | null
}
```

The API returns this capability shape. The SDK normalizes and caches it. Web and
mobile render it. No host rebuilds it from secrets, billing state, models.dev,
or agent names.

## 4. Agent and runtime resolution

The only resolution path is:

```text
kortix.yaml agent name
  -> runtime profile name
  -> harness + native config directory
  -> compiled launch plan
  -> project config agent summary
  -> SDK Agent
  -> composer/session creation
```

Required behavior:

- The declared default agent is shown first and selected for new sessions.
- Disabled agents never appear and cannot be started through the API.
- Agent rows show logical name, harness label, runtime profile, description,
  and whether the harness uses a native/default or explicit catalog model.
- The composer never remembers an agent from another project over the current
  project's declared default.
- Selecting an agent immediately recomputes authentication and model controls.
- Existing sessions show their bound agent and harness and cannot silently
  switch either.
- API creation rejects undeclared, disabled, or mismatched agent/runtime input.

## 5. Authentication and connection model

### 5.1 Separate user-facing connections

These are separate provider cards and connection flows:

| Connection | Credential/config | Compatible harnesses |
| --- | --- | --- |
| Kortix managed gateway | sandbox-scoped Kortix token | all, subject to route support |
| Claude subscription | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude Code |
| Anthropic API key | `ANTHROPIC_API_KEY` or explicit auth token | Claude Code; compatible native consumers |
| ChatGPT/Codex subscription | server-side `CODEX_AUTH_JSON` device login | Codex through refresh-capable Kortix gateway |
| OpenAI API key | `OPENAI_API_KEY` or `CODEX_API_KEY` | Codex; compatible native consumers |
| OpenAI-compatible REST | base URL, optional key, model id | Codex, OpenCode, Pi |
| Anthropic-compatible REST | base URL, optional key, model id | Claude Code |
| Harness-native config | native config directory | owning harness only |

Claude subscription and Anthropic API key must never share one card. ChatGPT
subscription and OpenAI API key must never share one card.

### 5.2 Explicit active route

Multiple compatible credentials may be stored, but ambiguity is forbidden. Each
harness has one explicit active authentication route. Connecting a new route may
offer “Use for Claude/Codex/OpenCode/Pi”; it must not silently steal another
harness unless the user confirms it.

The control-plane preference stores only non-secret routing metadata. Secret
values remain encrypted in the project secret store or server-side OAuth store.

Fallback is deterministic:

1. explicit harness connection binding;
2. harness-native config when declared and valid;
3. Kortix managed gateway when enabled and entitled;
4. not ready, with a harness-specific setup action.

There is no precedence based on whichever environment variable happens to be
present first.

### 5.3 Security and rotation

- `CODEX_AUTH_JSON` and other refresh credentials remain server-side.
- Claude setup tokens reach only the Claude ACP process.
- API keys reach only compatible launch processes and the agent's granted env.
- Secret list/read APIs return metadata, never values.
- Disconnect deletes the complete connection, not one arbitrary env var.
- Rotation updates the encrypted value and recycles idle matching processes.
- Busy turns are never killed. The UI says when a restart is required.
- Stderr, diagnostics, transcript, and audit payloads redact all credential
  values and generated authorization headers.

## 6. Model sources and selection

### 6.1 Catalog sources

| Route | Catalog source |
| --- | --- |
| Anthropic/OpenAI API keys | models.dev metadata, filtered by connection compatibility |
| Managed Kortix gateway | Kortix gateway catalog and entitlement response |
| OpenCode | native ACP config options/provider discovery when available; otherwise native config |
| Pi | native `models.json` / ACP config options |
| Claude subscription | authenticated Claude harness options when exposed; otherwise no fabricated list |
| ChatGPT subscription | authenticated Codex/gateway options when exposed; otherwise no fabricated list |
| Custom endpoint | user-declared model IDs plus optional endpoint discovery when supported |

models.dev supplies API metadata. It is never used as proof that a subscription
account can access a model.

### 6.2 Model selector behavior

After selecting an agent, the model control offers:

1. **Default** — the harness/active route chooses its native default.
2. **Presets** — only models from an authoritative catalog for the active route.
3. **Custom model…** — a free-form model ID for every harness.

Custom IDs receive syntax/length validation only. The harness/provider is the
authority and its rejection is shown verbatim with connection and model context.

No model is required when `Default` is valid. A missing gateway catalog must not
block Claude, Codex, or Pi from using their harness default. Conversely,
OpenCode using a gateway route must not start when no usable gateway/native model
exists.

### 6.3 Launch translation

The canonical selection is translated only at launch/config boundaries:

| Harness | Default | Explicit/custom translation |
| --- | --- | --- |
| Claude | omit override | `ANTHROPIC_MODEL` or adapter-native launch configuration |
| Codex | omit override | `CODEX_CONFIG.model` plus selected provider definition |
| OpenCode | native configured default | ACP model config option or native provider/model override |
| Pi | active native model | selected entry/provider in `models.json` or ACP model option |

The prompt payload remains raw ACP. Kortix must not invent a non-standard model
field on `session/prompt`.

### 6.4 Persistence and defaults

- Project/account gateway defaults continue to apply only to gateway-catalog
  routes.
- Harness defaults live in harness-native configuration.
- A new-session explicit/custom choice is stored on the Kortix session as a
  harness-qualified launch selection.
- Per-agent UI defaults store a harness-qualified selection and are invalidated
  when the agent changes harness.
- Old `opencode_model` fields migrate to the neutral session launch selection;
  compatibility reads remain until every producer is migrated.
- Headless sessions resolve the same defaults through the API, never a browser
  localStorage value.

## 7. Composer UX contract

The composer is a deterministic state machine:

```text
load project agents
  -> select declared/default agent
  -> load SDK composer capabilities
  -> show compatible auth + model state
  -> validate input
  -> create immutable session binding
  -> launch harness
  -> send raw ACP prompt
```

Required states:

- loading: stable skeleton, no “no model” flash;
- ready/default: send enabled without an explicit model;
- ready/preset or custom: selected value and source are visible;
- missing auth: send disabled with one direct connection action;
- missing model only when the active route truly requires one;
- invalid custom model: inline validation;
- provisioning: optimistic prompt retained and recoverable;
- failed provisioning: exact provider/runtime error and retry;
- active session: bound agent/harness visible; only live-supported config may change;
- permission/question: composer locks only the action that conflicts;
- credential changed: idle restart automatic, busy restart deferred and visible.

Agent selection rows show harness badges. Model controls never show models from an
incompatible provider. Switching agents cannot leak the previous model into the
new session payload.

## 8. Session, ACP, and UI parity

Every harness must support, where advertised:

- initialize, new, load, prompt, cancel, and reconnect;
- streaming assistant text and thoughts;
- tool calls, updates, terminal output, file edits, and failures;
- permission request/allow once/allow always/reject;
- elicitation/question input and cancellation;
- plans/todos when represented by ACP or a namespaced extension;
- attachment and image resources;
- context control and token/usage display when supplied;
- transcript persistence, reload, Markdown/JSONL export, and public share;
- tool side panel and changes/files/terminal surfaces;
- error and completion delivery to web, mobile, Slack, schedules, webhooks, and
  other headless callers.

Unsupported capabilities are omitted or labeled unsupported. They are never
rendered as broken empty OpenCode controls.

The ACP session page must retain behavioral and visual parity with the current
main session experience: context/token status in the chat input, attachments,
agent/model controls, stop/send/retry behavior, scroll and streaming behavior,
tool-call cards and the complete tool side panel, changes/files/terminal panes,
responsive mobile layout, keyboard behavior, and recovery after reload. Parity
means the same user action remains possible and produces the same visible state;
it does not mean preserving an OpenCode-shaped internal type.

## 9. SDK and API surface

The SDK must expose session-scoped, harness-neutral APIs:

```ts
kortix.project(projectId).agents()
kortix.project(projectId).harnessConnections()
kortix.project(projectId).composerCapabilities(agentName)
kortix.project(projectId).modelCatalog({ agentName, connectionId })
kortix.project(projectId).createSession({ agentName, modelSelection })
kortix.session(projectId, sessionId).start()
kortix.session(projectId, sessionId).acp
```

React hosts consume SDK hooks over these APIs. Capability queries are keyed by
project, agent, harness, active connection, account entitlement, and relevant
secret revision. Credential changes invalidate the complete dependency set.

The API performs the same preflight as the UI. A CLI, Slack trigger, schedule,
or webhook cannot bypass agent/auth/model validation or receive a different
default.

## 10. Migration and deletion

The implementation must inventory and migrate:

- `modelRequired`, `hasSelectableModels`, and universal model connection gates;
- `opencode_model`, `open_code_*`, and OpenCode provider/session semantics;
- `use-opencode-*`, OpenCode message/part/event types, and direct runtime clients;
- host-local provider/auth inference;
- mobile runtime/model/agent stores;
- Slack/channel/schedule model pickers and bindings;
- transcript/share serializers with OpenCode-only fields;
- starter and docs references that imply every agent is OpenCode.

OpenCode remains supported as an ACP harness. Its HTTP API and SDK are not the
Kortix client protocol or public data model.

## 11. Sandbox image and artifact reproducibility

The production sandbox image contains the Kortix daemon, Kortix CLI, Claude ACP
adapter, Codex ACP adapter, OpenCode harness/adapter, and Pi ACP adapter. Every
package is pinned and probed during the image build. A successful package
installation without an executable/version probe is not sufficient.

The runtime artifact contract is:

- checkout-owned `kortix-agent` source and `dist/kortix-agent` may never drift;
- worktree creation/start and primary local start build required artifacts;
- snapshot staging is the final enforcement boundary and automatically repairs
  a missing/stale checkout-owned daemon artifact before hashing or uploading;
- simultaneous cold and warm builds collapse onto one daemon compile;
- an explicit deployment artifact path is immutable and is validated, never
  rebuilt from an incidental checkout;
- a failed or still-stale rebuild fails before any provider upload;
- default and per-project warm images carry the same runtime content hash;
- build logs redact clone credentials, API keys, OAuth tokens, authorization
  headers, and provider upload credentials.

Required image proof is a complete chain, not a `202` response:

```text
source edit or clean checkout
  -> artifact build/typecheck succeeds
  -> staged context contains fresh Linux executable + CLI + adapters
  -> shared default build reaches ready
  -> first real session boots default and reaches ACP ready
  -> per-project default-warm build reaches ready
  -> second session selects default-warm and reaches ACP ready
  -> real ACP initialize/load-or-new/prompt/tool/transcript succeeds
```

## 12. Acceptance matrix

### 12.1 Agent/routing

- each starter agent resolves to the declared runtime and harness;
- default, explicit, disabled, missing, and renamed agents;
- runtime profile rename and harness change;
- session binding immutable across restart/reprovision;
- two concurrent sessions using different harnesses.

### 12.2 Authentication

For each compatible harness, test connect, list metadata, select active,
launch, rotate, disconnect, reconnect, invalid credential, revoked credential,
and credential change during idle and busy turns for:

- managed gateway;
- Claude subscription;
- ChatGPT subscription including refresh;
- Anthropic API key;
- OpenAI/Codex API key;
- authenticated and unauthenticated custom endpoints;
- native config.

Also assert every incompatible pairing is absent/rejected and no secret appears
in child env, logs, API responses, transcript, or browser state beyond the
minimum required by the compatible harness.

### 12.3 Models

For every harness/auth combination:

- default with no explicit model;
- authoritative preset;
- custom model accepted;
- custom model rejected by upstream;
- stale remembered model from another agent/harness is discarded;
- connection switch recomputes catalog;
- no catalog does not block a valid harness default;
- true no-model/no-auth state blocks with the correct action;
- launch translation has the exact native value;
- mid-session model change supported and unsupported behavior;
- agent, project, account, session, channel, schedule, and webhook defaults.

### 12.4 ACP/session parity

Run the full conversation/tool/permission/question/context/transcript/reconnect/
restart/share matrix against Claude, Codex, OpenCode, and Pi in the production
sandbox image. The same logical assertions run against every harness; explicitly
document adapter-specific unsupported features.

### 12.5 Surfaces

- API black-box requests and persisted read-back;
- real CLI processes;
- real web DOM plus outgoing payload assertions at desktop and mobile widths;
- native mobile behavior;
- Slack, schedules, webhooks, and channel bindings;
- starter project from zero through first successful turn;
- existing v2 project migration and transcript compatibility.

### 12.6 Sandbox artifacts

- missing daemon binary self-builds before staging;
- source newer than daemon binary self-builds before staging;
- concurrent default/warm staging performs one daemon build;
- failed compile creates no provider build;
- shared default reaches `ready` with the expected content hash;
- first cold session boots from shared default and completes an ACP tool turn;
- per-project `default-warm` reaches `ready` with the same content hash;
- second session boots from `default-warm` and completes an ACP turn;
- a clean image build probes exact Claude/Codex/OpenCode/Pi adapter versions;
- provider and API logs contain no credential material.

## 13. Execution plan and gates

Work proceeds in dependency order. A later phase does not make an earlier red
gate acceptable.

1. **Contract and inventory** — land this spec; generate an inventory of every
   OpenCode-named import/type/route/store/hook and classify it as remove, neutral
   rename, compatibility shim, or harness-internal.
2. **Compiler and persisted schema** — complete `kortix.yaml` v3, one compiler
   entrypoint, neutral agent/runtime/auth/model/session records, migrations, and
   v2 compatibility reads. Gate: compiler + real project read-back matrix green.
3. **Sandbox runtime** — pin/install/probe all adapters; complete launch-plan
   translation, auth isolation, daemon ACP supervision, permissions,
   elicitation, transcript, and deterministic shutdown/recycle. Gate: image and
   sandbox artifact matrix green.
4. **API and SDK authority** — implement connection, capability, catalog,
   session, ACP, transcript/share, and invalidation surfaces in `@kortix/sdk`;
   remove host-local transport/inference. Gate: public snapshots, contract tests,
   and authenticated HTTP read-back green.
5. **Composer and Customize UX** — implement harness-aware agents, separate auth
   cards, explicit active routes, default/preset/custom models, validation, and
   native config editing without OpenCode assumptions. Gate: desktop/mobile DOM
   plus exact request payload assertions green.
6. **Session parity** — restore every main chat-input, context, streaming, tool
   side-panel, files/changes/terminal, permission/question, share/export, reload,
   and recovery behavior on neutral ACP state. Gate: visual/behavioral parity E2E
   green for all four harnesses.
7. **Headless and mobile parity** — migrate mobile, Slack, schedules, webhooks,
   channels, CLI, and other programmatic callers to the same SDK capability and
   preflight path. Gate: each surface has its own black-box proof.
8. **Deletion and hardening** — remove Kortix application dependency/public APIs
   for the OpenCode SDK/API, retain only OpenCode harness internals, run secret
   leak and stale-name scans, and update starter/docs. Gate: forbidden-import and
   forbidden-wire-contract scans green.
9. **Final matrix** — run clean starter, migrated v2, auth/model negative paths,
   concurrent multi-harness sessions, real Daytona turns for Claude/Codex/
   OpenCode/Pi, browser parity, and PR checks. Record every matrix cell and its
   evidence. PR #4510 stays isolated and unmerged until explicit authorization.

## 14. Required proof before completion

1. Focused unit/type/lint tests for every changed decision function.
2. API contract tests with real HTTP and persisted read-back.
3. Browser E2E asserting agent selection, connection selection, model controls,
   session payload, visible streamed result, tools, and recovery.
4. Real Daytona E2E for all four harnesses, both managed and every available
   live credential mode. Credential-dependent live tests are opt-in but must be
   run before that mode is called verified.
5. Image build/probe proves pinned adapters and CLI versions.
6. Secret-leak scan and transcript/log inspection.
7. SDK public-surface snapshots, docs, starter, mobile, and headless suites.
8. PR #4510 mergeable with required checks green. It remains unmerged until the
   user explicitly changes the isolation instruction.

Any unavailable third-party credential or provider outage is reported as an
explicit unverified matrix cell, never converted into a pass.

There is no percentage-based completion. The goal is complete only when every
required matrix cell is implemented and evidenced, all unsupported cells are
explicit adapter capability decisions rather than accidental gaps, no known
regression remains, and the branch is clean, pushed, mergeable, and still
isolated from `main`.
