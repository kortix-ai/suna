# Default Model Resolution — Spec

> Status: **approved, implementing** · 2026-06-28 · Author: Marko + Claude
> Scope decision: **core product + gateway** (this monorepo). The separate
> "Kortix automat" tickets/automations product already has its own `default_model`
> in its own server — out of scope here.
> Authority decision: **the gateway resolves; retire the client/sandbox hacks.**

---

## 0. Problem

There is no proper default model. Today "the default" is smeared across three
places, none authoritative:

1. `localStorage.globalDefault` (per-browser, not per-account, not cross-device).
2. A per-**sandbox** `opencode.jsonc` value read/written via
   `GET/PUT /kortix/preferences/model` (served by the opencode binary, not our API).
3. A build-time `AUTO_DEFAULT_MODEL_ID` compatibility constant used by clients,
   rather than runtime routing configuration owned by the control plane.

Resolution is 100% client-side (`use-opencode-local.ts`: per-session > per-agent >
globalDefault > agent.model > fallback), and since AUTO is hidden the client
substitutes `kortix/glm-5.2`. So:

- The gateway, the actual central LLM path, has **no concept** of an account- or
  agent-configured default. It only knows `auto → glm-5.2`.
- A user's "default" doesn't follow them across devices or even across sandboxes.
- "Every agent should have its own default model" is impossible — core agents are
  git `.md` files with no server-side per-agent model store.

## 1. Target: the gateway is the single source of truth

Resolution moves **server-side**, into the gateway's existing `auto` indirection.
The client (and headless/channel/cron callers) send `auto` (`kortix/auto`) when no
concrete model is chosen and **trust the gateway** to resolve it.

### Resolution order (most-specific wins)

```
1. Explicit request model      body.model is a concrete id (not `auto`)      → pass-through
2. Per-session model           project_sessions.metadata.opencode_model      → applied at sandbox boot
                               (concrete model → opencode sends it, not auto)
3. Per-agent default           account_model_preferences (scope='agent', key=agent_name)
4. Account default             account_model_preferences (scope='account')
5. Platform default            LLM_GATEWAY_DEFAULT_MODEL, vision→LLM_GATEWAY_VISION_MODEL
```

Levels 3–5 are what `auto` resolves to. Levels 1–2 never reach the resolver — a
concrete model is passed through unchanged (level 2 is applied earlier: a session
with `metadata.opencode_model` boots opencode with that concrete model).

### Where each piece runs

- **`resolveGatewayRoute(principal, input)`** (API control plane): when the model
  is `auto`, selects `principal.defaultModel ?? LLM_GATEWAY_DEFAULT_MODEL`, applies
  the configured vision target when required, and attaches the matching
  declarative fallback policy.
- **`principal.defaultModel`** (new field on `AuthedPrincipal`): the resolved
  agent/account default (a concrete wire model, never `auto`). Resolved **once at
  authentication** in `withResolvedTier` (apps/api `hooks.ts`) and travels with the
  principal across the RPC boundary to the pod — exactly like `tier`/`freeModelsOnly`.
- **In-process gateway** calls `resolveGatewayRoute` directly through a hook.
- **Standalone gateway** calls `/internal/gateway/resolve-route`; it contains no
  platform model ids or product fallback policy.
- **`resolveCandidates`** defensively calls the same control-plane resolver for
  stale callers that still send raw `auto`.

### Free tier (critical)

Free tier (`freeModelsOnly`) has **no managed default** by design — managed
resolution returns `[]` (→ 400, UI blocks). The resolver therefore **drops a
managed default for free-tier principals** (`defaultModel = undefined`), so `auto`
falls to the platform target and yields the same "no managed model" behavior as
today. A **BYOK** default (provider the user connected) is still honored for free
tier (it resolves via their own key, unbilled). The set-endpoint validates the same
way: a free-tier account can only set a BYOK default, never a managed one.

## 2. Data model

New table, mirroring `credit_accounts` (one logical row per account-scope-key):

```sql
kortix.account_model_preferences
  id          uuid PK default gen_random_uuid()
  account_id  uuid NOT NULL  → accounts(account_id) ON DELETE CASCADE
  scope       text NOT NULL                 -- 'account' | 'agent'
  scope_key   text NOT NULL DEFAULT ''      -- '' for account; agent_name for agent
  model       varchar(128) NOT NULL         -- gateway wire model: 'glm-5.2' | 'anthropic/claude-…' | 'codex/…'
  updated_by  uuid                          -- user who last set it
  created_at  timestamptz NOT NULL default now()
  updated_at  timestamptz NOT NULL default now()
  UNIQUE (account_id, scope, scope_key)
```

`model` is stored as the **gateway wire model** (what `resolveCandidates` resolves):
a bare managed id (`glm-5.2`), a BYOK `provider/model` (`anthropic/claude-sonnet-4.6`),
or `codex/<id>`. The frontend converts its `{providerID, modelID}` ModelKey to/from
this string.

Per-session model keeps its existing home (`project_sessions.metadata.opencode_model`).
Channel bindings keep theirs (`chat_channel_bindings.opencode_model`).

## 3. API

Project-scoped (auth via `loadProjectForUser`), operating on the **project's owner
account** — the same account the gateway principal carries, so the picker and the
gateway agree.

```
GET    /v1/projects/:projectId/model-defaults
  → { platformDefault, accountDefault: string|null,
      agentDefaults: { [agentName]: string },
      resolvedForCaller: string|null }     // what `auto` resolves to for this account, vision-agnostic

PUT    /v1/projects/:projectId/model-defaults
  body { scope: 'account'|'agent', agentName?: string, model: string }
  → validates the model is servable for the account (managed-if-entitled OR
    connected BYOK). Free tier: managed rejected (409 model_not_entitled). Upsert.

DELETE /v1/projects/:projectId/model-defaults?scope=account
DELETE /v1/projects/:projectId/model-defaults?scope=agent&agentName=<name>
  → clear; resolution falls through to the next level.
```

## 4. Frontend

- New `use-model-defaults` hook: fetches the server defaults for the active project;
  exposes `setAccountDefault`, `setAgentDefault`, `clearAgentDefault`.
- **Account default**: the onboarding "Default model" pane and the settings dialog
  write `scope='account'` to the server (replacing `setGlobalDefaultModel`
  localStorage). The picker badges the resolved default as "Default".
- **Per-agent default**: a model selector at the agent level — set the agent's
  default model (`scope='agent'`); shown in the agent area / agent settings.
- **Resolution**: when the user is on "default", the client sends `auto`
  (`kortix/auto`) and trusts the gateway; the displayed model is the server-resolved
  default (concrete) with a "Default" badge. An explicit pick sends that concrete
  model and is remembered per-session/per-agent (as today).
- **Retire**: `hydrateGlobalDefaultFromServer` + the `/kortix/preferences/model`
  round-trip in `use-model-hydration.ts`; the localStorage `globalDefault` as the
  authority (kept only as an offline display cache, seeded from the server).

## 5. Sandbox / headless

No change needed: the sandbox already boots `model: kortix/auto`
(`DEFAULT_KORTIX_MODEL`), and channel/cron sessions send `auto` unless they set a
concrete `opencode_model`. The gateway now resolves that `auto` against the
session's account + agent defaults automatically — headless sessions get the right
default with zero client involvement, which is the whole point of moving resolution
server-side.

## 6. Edge cases

- **Stale default** (e.g. a BYOK provider got disconnected, or a managed model was
  removed): resolution validates the stored default is still servable; if not, it
  falls through to the next level. `resolveCandidates` already returns `[]` for an
  unservable model, so the worst case degrades to the platform default, never a hard
  failure of `auto`.
- **Vision**: if the resolved default is a managed text-only model and the request
  has an image, override to `AUTO_VISION_MODEL` (claude-sonnet-4.6) — unchanged
  behavior. A vision-capable default (e.g. Opus) is kept as-is.
- **Self-host (`KORTIX_BILLING_INTERNAL_ENABLED` off)**: everyone is full-lineup
  (`freeModelsOnly=false`); defaults resolve using the operator's gateway config.
- **Performance**: `withResolvedTier` resolves the default every auth; account prefs
  and the session→agent_name lookup are cached (short TTL, like the tier cache).

## 7. Out of scope

- The separate Kortix-automat / tickets / scheduled-triggers product (its own server
  + `kortix.toml`) — already has `default_model`.
- Reworking the gateway deployment modes or the gateway-vs-native debate (see
  `llm-gateway-refactor.md` / `llm-native-refactor.md`). This design is agnostic to
  that: it adds server-side default resolution to whatever the server-side LLM path
  is.
</content>
</invoke>
