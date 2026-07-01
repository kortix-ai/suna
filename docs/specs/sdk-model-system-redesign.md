# SDK model system redesign — defaults (project / agent / trigger) + free-tier as a pure gateway concern

Status: **draft / for review** · Owner: SDK refactor (branch `whitelabel-demo`)

## Goal

Make model selection and defaults a **first-class, dead-simple SDK/API surface**:

- Set/get the **default model** at **project**, **agent**, and **trigger** scope
  through the SDK, cleanly — no host-local logic, no ugly key juggling.
- Treat the **Kortix LLM gateway as the sole authority** for entitlement
  (free-tier / subscription / budget). Kortix managed models are **just a
  provider**; the client passes the user's token and renders the catalog the
  server hands back. **No free-tier logic in the SDK/client.**
- `@kortix/sdk` is the single source of truth — apps consume it.

## TL;DR of the current state

Three layers, mapped:

1. **Gateway (already correct).** Entitlement is enforced *entirely server-side*.
   The gateway authenticates the token → resolves the account tier → (a) filters
   the `/llm-catalog` per tier and (b) rejects an unavailable managed model at
   request time (402/400). `executor-sdk` has **zero** tier logic. Kortix is
   injected into OpenCode as an OpenAI-compatible provider (`kortix`) via
   `KORTIX_LLM_API_KEY` + `KORTIX_LLM_BASE_URL`. **This is exactly the architecture
   you want — it already exists.**
2. **API/DB (defaults are account-scoped only).** `account_model_preferences`
   (`accountId, scope ∈ {account,agent}, scopeKey, model`) backs
   `GET/PUT/DELETE /projects/:id/model-defaults`. Resolution: per-agent → account
   → platform (`auto`). **There is no project-scope and no trigger-scope**, and
   neither agents (`AgentSpec`) nor triggers (`GitTriggerSpec`) carry a model
   field. That's the real gap.
3. **Client/SDK (where it's messy).** The branch SDK re-implements free-tier
   filtering client-side (`freeTier` flag + `FREE_MANAGED_MODEL_IDS` +
   `DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS`) — redundant with the gateway. main
   added a server-backed model-defaults feature (`useModelDefaults`,
   `get/setModelDefault`, `modelKeyToWire`/`wireToModelKey`, `sendKey` vs
   `currentKey`, `onDefault`) that the branch's SDK never absorbed → the merge
   conflict. Free-tier currently lives in **three** client places; model defaults
   in **two** paradigms (localStorage `globalDefault` vs server-backed).

Key files: `apps/api/src/llm-gateway/**` (gateway), `apps/api/src/projects/routes/r4.ts`
+ `account_model_preferences` (defaults), `apps/api/src/llm-gateway/models/catalog-models.ts`
(catalog), `packages/sdk/src/react/use-model-store.ts` + `use-opencode-local.ts`
(client), `apps/kortix-sandbox-agent-server/src/opencode.ts` (provider injection).

## The two problems to fix

### P1 — Free-tier leaks into the SDK/client (it shouldn't exist there at all)

The gateway already filters the catalog per tier and rejects unavailable models.
The client re-deriving "free tier" from billing state and hiding models is
**redundant and a wrong concern**. It also creates two sources of truth (client
`useAccountState` calc vs the server `freeTier` flag) and special-case granularity
(`FREE_MANAGED_MODEL_IDS`).

### P2 — Defaults can't be set where you actually want them

You want: **project default**, **agent default**, **trigger default**. Today only
**account** + **agent** defaults exist, account-scoped. There's no project-level
default and no per-trigger model.

## Target design

### 1. Free-tier: delete it from the client

- The **`/llm-catalog` response is the one source of truth** for "what models can
  this caller use." It is already tier-filtered server-side. The client renders
  exactly that list — nothing more, nothing less.
- **Remove from the SDK:** the `freeTier` option, `FREE_MANAGED_MODEL_IDS`, the
  `DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS` dependency, and every visibility gate
  keyed on free-tier. `useModelStore`/`useOpenCodeLocal` stop knowing about tiers.
- If a caller ever sends a model it isn't entitled to, the gateway returns a clear
  **402/400**; the SDK surfaces that as a normal runtime error (same path as any
  send error). No pre-emptive client gating.
- Net: Kortix managed models are **just a provider** in the catalog; the user's
  token + the gateway decide entitlement. Clean concern separation, as intended.

### 2. Model defaults: one scoped surface, server-resolved

**Resolution precedence (most-specific wins):**

```
explicit pick  >  trigger.model  >  agent default  >  project default  >  account default  >  platform(auto)
```

- **`model_preferences`** (a generalized `account_model_preferences`) holds the
  reusable defaults — `scope ∈ {account, project, agent}` + `scopeKey`
  (`projectId` for project, `agentName` for agent) + `model`.
- **`trigger.model`** is a nullable field on the `kortix.toml` `[[triggers]]`
  entry itself (set where you create the trigger; `null`/absent = "Default" =
  resolve the chain). It is the most-specific *default-time* override for that run.
- **`agent.model`** is a nullable field on the `kortix.toml` `[[agents]]` entry —
  the agent's declarative default. A `model_preferences` (scope=agent) row is an
  optional dynamic override (wins over the manifest). So "agent default" =
  `model_preferences.agent ?? manifest [[agents]].model`.

**API.** Generalize `model-defaults` from `{account,agent}` to `{account,project,agent}`:

```
GET    /projects/:id/model-defaults
  → { platformDefault, accountDefault, projectDefault,
      agentDefaults: Record<agent, wire>, resolvedForCaller }   // no freeTier — gateway owns that
PUT    /projects/:id/model-defaults   { scope:'project'|'account'|'agent', key?, model }
DELETE /projects/:id/model-defaults?scope=…&key=…
```

Trigger/webhook model is set through the **triggers API** (the new `model` field on
the trigger spec), not `model-defaults`. Resolution lives in
`apps/api/src/llm-gateway/resolution/default-model.ts`, extended to the precedence
above (and checking `trigger.model` first for trigger runs) wherever `auto` resolves.

**Client sends `auto`, server resolves.** Adopt main's display/send split:
- `currentKey` = what to *show* (the resolved default or the user's explicit pick).
- `sendKey` = what to *send*: the explicit pick, else **`auto`**. The gateway
  resolves `auto` through the precedence chain at request time.
- `onDefault` = true when the user hasn't overridden — UI shows a "Default" hint.

Why this matters: the client never encodes the precedence. Changing a project or
agent default takes effect **immediately** in live sessions (they send `auto`),
and chat history isn't polluted with implicit picks.

### 3. The SDK surface (what hosts actually call)

```ts
// Catalog — already tier-filtered by the server; render as-is.
kortix.project(id).llmCatalog()                       // → models the caller can use

// Defaults — one clean CRUD (account / project / agent scope):
kortix.project(id).modelDefaults.get()                // → resolved + per-scope map
kortix.project(id).modelDefaults.set({ scope:'project', model })
kortix.project(id).modelDefaults.set({ scope:'account', model })
kortix.project(id).modelDefaults.set({ scope:'agent',   key: agentName, model })
kortix.project(id).modelDefaults.clear({ scope, key? })

// Triggers/webhooks carry their own agent + model (model: null = "Default"):
kortix.project(id).triggers.create({ ...trigger, agent, model: model ?? null })
kortix.project(id).triggers.update(triggerId, { agent, model })

// React helpers (server-backed, optimistic):
useModelDefaults(projectId)   // { resolvedFor(agent?), set*, clear*, isLoading }
useModelPicker(projectId, { sessionId, agentName })  // { current, sendKey, onDefault, list, set }
// The trigger/webhook form reuses an <AgentSelect/> + <ModelSelect/> (Default + catalog)
// both reading the same SDK catalog/defaults — one selector, used everywhere.
```

All of this lives in **`@kortix/sdk`** (`projects-client` + `react`). `apps/web`,
`apps/whitelabel-demo`, `apps/mobile` consume it; no host re-implements it. Wire
↔ key conversion (`modelKeyToWire`/`wireToModelKey`) is an SDK internal, exposed
only if a host truly needs it.

## Migration plan

1. **API + manifest** — (a) generalize `model-defaults` to `{account,project,agent}`
   scope (`model_preferences` table + routes + `default-model.ts` resolution),
   dropping `freeTier` from the response (the catalog already encodes availability);
   (b) add a nullable **`model`** to `kortix.toml` `[[agents]]` (`AgentSpec`) and
   `[[triggers]]` (`GitTriggerSpec`) — parse + serialize + validate against the
   catalog — and have the trigger run resolver check `trigger.model` first, then
   the agent's `model` (manifest, then DB override). The triggers routes already
   round-trip the manifest; the agent + model selectors in the UI edit it.
2. **SDK** — port main's model-defaults into the SDK (not `apps/web`):
   `projects-client.modelDefaults.*` (account/project/agent), `useModelDefaults`,
   the `currentKey`/`sendKey`/`onDefault` split, `modelKeyToWire`/`wireToModelKey`
   as internals; extend `triggers.create/update` to carry `agent` + `model`.
   **Delete** `freeTier`, `FREE_MANAGED_MODEL_IDS`, and the
   `DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS` dependency.
3. **Hosts** — keep `apps/web` modules as SDK shims; delete the client-side
   `useAccountState`-based free-tier calc. Ship one reusable `<AgentSelect/>` +
   `<ModelSelect/>` (Default + catalog) used by the composer, project/agent
   settings, **and the trigger + webhook creation forms** — all reading the same
   SDK catalog/defaults. The demo's `model-picker`/`composer` read `sendKey`.
4. **Merge reconciliation** — this supersedes the blocked `origin/main` merge:
   instead of porting main's *account-scoped* defaults as-is, land the
   project/agent/trigger-scoped version above. Resolves the 23 type errors at the
   source (the SDK gains the symbols the merged consumers expect).

## Decisions (locked, 2026-06-28)

1. **Project overrides account.** The "account" default is your **personal
   account** default (the model you pick for yourself); a **project** default
   overrides it for that project. Full precedence for an effective model:

   ```
   explicit pick (session/composer)         // a user's in-the-moment choice
     > trigger model (if the run is a trigger and its model is set)
     > agent default                          // per-agent, set via SDK
     > project default                        // overrides account
     > account (personal) default
     > platform default (auto → gateway picks)
   ```

2. **Triggers + webhooks carry an agent AND a model — in `kortix.toml`.** A
   cron schedule or webhook exposes a **server-side selector for both the agent
   and the model**, persisted into the project manifest `[[triggers]]` entry
   (which already has `agent`; add a nullable **`model`**). `null`/absent ⇒
   **"Default"** ⇒ resolve the chain at run time. `kortix.toml` is the source of
   truth for triggers; the UI/API edits + serializes the manifest (the trigger
   routes already round-trip it).

3. **Agents declare a default model — in `kortix.toml`.** Add a nullable
   **`model`** to `[[agents]]` (alongside `name`/`connectors`/…). This is the
   agent's declarative default. A `model_preferences` row (scope=agent) is an
   optional **dynamic override** set via the SDK/UI without a code commit
   (override wins). The agent picker in a trigger/webhook chooses *which* agent;
   that agent's own `model` (manifest or DB override) is its default.

   **Where each default lives (two homes, one resolution path):**
   - **`kortix.toml` (declarative, committed code):** `[[agents]].model`,
     `[[triggers]].agent` + `.model`. Project-as-code config.
   - **DB `model_preferences` (dynamic, set via SDK/UI):** account (personal) +
     project defaults, and optional per-agent override. No manifest home needed —
     these are runtime/personal settings.

4. **Client sends `auto` on Default.** When the user is on a default (hasn't made
   an explicit pick), the client sends `auto` and the gateway resolves it through
   the chain. The shown model is a hint; the gateway is the source of truth for
   what `auto` becomes. Changing a project/agent default takes effect live.
