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

**Scopes (most-specific wins):**

```
trigger(triggerId)  >  agent(agentName)  >  project  >  account  >  platform(auto)
```

**API.** Generalize `model-defaults` from `{account,agent}` to a scope tuple:

```
GET    /projects/:id/model-defaults
  → { platformDefault, accountDefault, projectDefault,
      agentDefaults: Record<agent, wire>, triggerDefaults: Record<triggerId, wire>,
      resolvedForCaller }                      // NOTE: no freeTier field — gateway owns that
PUT    /projects/:id/model-defaults   { scope:'project'|'account'|'agent'|'trigger', key?, model }
DELETE /projects/:id/model-defaults?scope=…&key=…
```

Persistence: extend `account_model_preferences` (or a new `model_preferences`)
to carry `projectId` + `scope ∈ {account,project,agent,trigger}` + `scopeKey`.
Resolution lives in `apps/api/src/llm-gateway/resolution/default-model.ts`,
extended to the precedence above and applied wherever `auto` is resolved.

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

// Defaults — one clean CRUD, all scopes:
kortix.project(id).modelDefaults.get()                // → resolved + per-scope map
kortix.project(id).modelDefaults.set({ scope:'project', model })
kortix.project(id).modelDefaults.set({ scope:'agent',   key: agentName,  model })
kortix.project(id).modelDefaults.set({ scope:'trigger', key: triggerId,  model })
kortix.project(id).modelDefaults.clear({ scope, key? })

// React: one hook, server-backed, optimistic.
useModelDefaults(projectId)   // { resolvedFor(agent?|trigger?), set*, clear*, isLoading }
useModelPicker(projectId, { sessionId, agentName })  // { current, sendKey, onDefault, list, set }
```

All of this lives in **`@kortix/sdk`** (`projects-client` + `react`). `apps/web`,
`apps/whitelabel-demo`, `apps/mobile` consume it; no host re-implements it. Wire
↔ key conversion (`modelKeyToWire`/`wireToModelKey`) is an SDK internal, exposed
only if a host truly needs it.

## Migration plan

1. **API** — generalize `model-defaults` to `{account,project,agent,trigger}`
   scope (DB column + routes + `default-model.ts` resolution). Drop `freeTier`
   from the response (the catalog already encodes availability).
2. **SDK** — port main's model-defaults into the SDK (not `apps/web`):
   `projects-client.modelDefaults.*`, `useModelDefaults`, the `currentKey`/
   `sendKey`/`onDefault` split, `modelKeyToWire`/`wireToModelKey` as internals.
   **Delete** `freeTier`, `FREE_MANAGED_MODEL_IDS`, and the
   `DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS` dependency.
3. **Hosts** — keep `apps/web` modules as SDK shims; delete the client-side
   `useAccountState`-based free-tier calc. The demo's `model-picker`/`composer`
   read `sendKey`.
4. **Merge reconciliation** — this supersedes the blocked `origin/main` merge:
   instead of porting main's *account-scoped* defaults as-is, land the
   project/agent/trigger-scoped version above. Resolves the 23 type errors at the
   source (the SDK gains the symbols the merged consumers expect).

## Open decisions (need your call)

1. **Project vs account precedence** — proposed `trigger > agent > project >
   account > platform`. Is a **project** default meant to *override* the account
   default (per-project wins), or only fill in when the account has none? (Spec
   assumes project overrides account.)
2. **Agent model field** — should an agent also be able to pin a model in its
   manifest (`AgentSpec.model`), or is the per-agent *default* (set via SDK) the
   only mechanism? (Spec uses the SDK default; no manifest field.)
3. **Trigger default storage** — per-trigger default in `model_preferences`
   (scope=trigger) vs a `model` field on `GitTriggerSpec`. (Spec uses
   `model_preferences` so all defaults share one resolution path.)
4. **`auto` everywhere** — OK to make the client always send `auto` when on a
   default (server resolves), accepting that the shown model is a hint that can
   differ from what the gateway ultimately picks for `auto`?
