# LLM Gateway Refactor — Ultimate Spec

> Status: proposal · Author: Marko + Claude · Date: 2026-06-26
> Goal: one reliable LLM path. Add a model → instantly selectable. Add a key → its
> models instantly selectable, no reload. Kill the dual implementation.

---

## 1. Decision (TL;DR)

**Go all-in on the centralized server-side gateway. Delete the native passthrough
path, proxy deployment mode, and the experimental opt-in gate.**

- **One pipeline, two bindings** — the gateway engine (`packages/llm-gateway`) is a
  single request pipeline. It binds **in-process** for local/self-host and as a
  **standalone pod** for cloud. That is *not* "two implementations" — it's one
  codebase with two transport bindings of the same hooks. Keep it.
- **The sandbox only ever holds ONE credential**: a scoped Kortix executor token +
  the gateway base URL. Raw provider keys (BYOK *and* managed) **never enter the
  sandbox**. opencode is locked to the `kortix` provider, always.
- **Provider keys live and are used server-side only.** Adding/rotating a key needs
  **no sandbox push and no opencode restart** — the gateway reads the key from the
  DB on the next request.

This is decisive because of one asymmetry: **managed models can never go native.**
You cannot put Kortix's own Bedrock/OpenRouter keys into a sandbox that runs
arbitrary agent code. Managed *requires* the gateway. Once the gateway exists for
managed, routing BYOK through it too collapses everything to one path and gets you
centralized metering, spend control, and "keys never leave the server" for free.

---

## 2. Requirements

1. Add a model in the catalog → it's immediately selectable in the picker.
2. Connect a provider (add API key) → that provider's models immediately selectable,
   **rendered nicely** (grouped under the provider, AUTO pinned on top), **no reload**.
3. Reliable: usage/billing never silently lost; no $0 leaks; no opaque failures.
4. Simple: one provisioning path, one deployment story per environment, no opt-in
   matrix, no triplicated logic.

---

## 3. Strategy evaluation: centralized gateway vs native passthrough

| Dimension | Centralized gateway (single Kortix token in sandbox) | Native passthrough (raw keys in sandbox) |
|---|---|---|
| **Managed models** | ✅ Works — Kortix keys stay server-side | ❌ **Impossible** — would leak Kortix's keys into agent-controlled sandbox |
| **Security** | ✅ No provider secret ever leaves the server | ❌ Raw BYOK keys sit in a sandbox running arbitrary code; exfiltratable |
| **Add-key UX** | ✅ Server-side; **no reload** — next request picks it up | ❌ Must push secret to sandbox + restart opencode on every change |
| **Analytics / metering** | ✅ Central usage, cost, traces, spend caps | ❌ None — calls go sandbox→provider directly |
| **Management** | ✅ One place to add models, set tiers, route, fail over | ❌ Per-sandbox env, no central control |
| **Code paths** | ✅ One | ❌ The dual native/gateway fork is the complexity we're killing |
| **Latency** | one extra hop through Kortix infra | marginally lower |
| **Infra** | a gateway (already exists) | none |

Native wins only on raw latency and "no extra infra" — but the infra already
exists, the latency delta is small, and native **cannot serve the managed/free
tiers at all**. Centralized wins every dimension the product actually cares about.

**Verdict: centralized everything. Remove native.**

---

## 4. Target architecture

### One pipeline, two bindings
```
                    packages/llm-gateway  (the ONLY pipeline)
   admit(authn + billing + budget) → autoRoute → resolveUpstream(candidates)
        → runFailover(retry + SHARED breaker) → transport → settle(durable usage + trace)
        ▲ hooks bound in-process              ▲ hooks bound over HTTP RPC
   ┌────┴───────────────────┐          ┌──────┴───────────────────────────┐
   │ IN-API (local / self-host)        │ STANDALONE POD (cloud prod/dev)   │
   │  /v1/llm in the API process        │ survives API rollouts; own ingress│
   └────────────────────────┘          └───────────────────────────────────┘
```

### Sandbox contract (the whole thing)
The sandbox receives exactly:
- `KORTIX_LLM_API_KEY` = scoped Kortix executor token (PAT) — the *only* credential.
- `KORTIX_LLM_BASE_URL` = `LLM_GATEWAY_BASE_URL` (cloud) **or** `${KORTIX_URL}/v1/llm`
  (local). One resolver, two branches. No proxy mode.
- opencode config: `kortix` provider only, `enabled_providers: ['kortix']`. Always.
- **No provider credential env vars are pushed to the sandbox, ever.**

### Request lifecycle (a model call from a sandbox)
```
opencode (kortix provider) ──Bearer kortix token──▶ KORTIX_LLM_BASE_URL
  → gateway.authenticate(token) → principal {accountId, projectId, sessionId}
  → billing/budget gate (per-request entitlement + affordability)  ← entitlement lives HERE now
  → pickAutoModel (auto → fusion / sonnet-for-vision)
  → resolveUpstream(model):
        bare id      → managed (Bedrock for Claude, OpenRouter else, Zen for free)
        provider/id  → BYOK: getProjectSecretValue(projectId, ANTHROPIC_API_KEY…) server-side
                       (+ managed fallback queued for 429/402/403 on paid tier)
  → runFailover → transport → stream SSE
  → settle: DURABLE usage ledger write + cost + trace (never fire-and-forget)
```

### Deployment
- **Cloud (prod/dev/staging):** standalone pod, `LLM_GATEWAY_BASE_URL=https://gateway*…/v1/llm`.
- **Local / self-host:** in-API, `/v1/llm`. No separate process.
- **Proxy mode: deleted.** (Prereq: migrate preview/ephemeral k8s envs off it — see §9.)

---

## 5. The two golden flows

### A. Developer adds a model
1. Add one entry to `MANAGED_MODELS` in `packages/shared/src/llm-catalog/index.ts`
   (`{ id, name, upstreamModelId, transport, pricingRef, tier, vision, limit }`).
2. Done. No other file. The catalog endpoint serves it; the picker renders it under
   its provider group; the gateway resolves + prices it.

For a BYOK provider model, it's already covered by the generated `CATALOG`; no edit
needed.

### B. User connects a provider (adds an API key)
1. `POST /v1/projects/:id/secrets` `{ name: "ANTHROPIC_API_KEY", value }` → encrypted
   at rest (AES-256-GCM, per-project HKDF key) in `kortix.project_secrets`.
2. Frontend marks the provider **connected** (from project secrets) → its catalog
   models become selectable instantly, grouped under "Anthropic", AUTO still pinned.
3. **Nothing is pushed to the sandbox. opencode is not restarted.** The next model
   call resolves the key server-side in `resolveCandidates`.

> This is the core ease-of-use win and the core security win in one move: because
> provider keys never go to the sandbox, "add key → use it" has zero sandbox-side
> steps and zero reload latency, and a compromised sandbox can never leak a key.

---

## 6. What gets ripped out (delete list)

### Native passthrough (the gateway-OFF else-branch, threaded through ~6 files)
- `apps/kortix-sandbox-agent-server/src/routes/env.ts` — `applyLlmGatewayMode`
  **delete the `!enabled` branch** that restores native keys; make gateway env
  unconditional. Drop the `llmGatewayEnabled` payload boolean.
- `apps/kortix-sandbox-agent-server/src/opencode.ts:40-174` — `buildOpencodeConfigContent`
  gateway-vs-native fork → **gateway provider unconditional**; keep
  `enabled_providers:['kortix']` (line ~155) but not behind `hasLlmGateway`.
- `apps/kortix-sandbox-agent-server/src/opencode.ts:572-590` — deny-env strip →
  keep, make unconditional.
- `apps/api/src/projects/lib/sessions.ts:239`, `sandbox-env-sync.ts:73-115` —
  conditional gateway env → always send gateway base + deny list.
- **Stop pushing provider-credential secrets to the sandbox at all.** Today even in
  gateway mode the decrypted BYOK key still lands in the sandbox env file (only
  opencode's subprocess env is scrubbed). Change secret propagation to **exclude
  `PROVIDER_CREDENTIAL_ENV` names** (`apps/api/src/llm-gateway/sandbox-credentials.ts`).
  Non-provider runtime secrets (MCP/connector/app env) still propagate. This also
  removes the `refreshModels`/`opencode.restart()` on provider-key change.
- `apps/api/src/llm-gateway/sandbox-credentials.ts` — KEEP (still defines which env
  names to withhold), now applied unconditionally.

### Three deployment modes → two
- `apps/api/src/llm-gateway/wire.ts:44-88` — **delete the reverse-proxy block.**
- `apps/api/src/config.ts` — delete `LLM_GATEWAY_PROXY_PORT` / `LLM_GATEWAY_PROXY_TARGET`
  (+ re-exports). `apps/api/.env` proxy settings removed.
- KEEP in-API mount (`wire.ts:19-40`) and standalone (`/internal/gateway`, `apps/llm-gateway/*`).

### Experimental opt-in gate (delete — gateway is always on)
- `apps/api/src/experimental/features.ts` — delete the `llm_gateway` registry entry
  and the `ExperimentalFeatureKey` union member (+ frontend mirror in
  `apps/web/src/lib/projects-client.ts`).
- `apps/api/src/llm-gateway/enablement.ts` — **delete file**; all callers become
  unconditional-true:
  - `session-sandbox.ts`, `warm-pool.ts`, `sessions.ts`, `session-lifecycle/actions.ts`,
    `projects/routes/shared.ts` — drop the `llmGatewayEnabled` param, always inject.
  - `projects/routes/r4.ts:1275` — delete the `llm_gateway_disabled` 404 gate.
  - `projects/routes/r6.ts:1110` — delete toggle-fanout.
  - `sandbox-env-sync.ts` — delete `resolveProjectLlmGatewayEnabled`,
    `propagateLlmGatewayModeToActiveSandboxes`, `markSandboxLlmGatewayMode`; stop
    writing `sessionSandboxes.config.llmGatewayEnabled`.
- `apps/api/src/config.ts` — delete **both** `LLM_GATEWAY_DEFAULT_ENABLED` and
  `LLM_GATEWAY_ENABLED`. **Decision: no kill-switch** — the gateway is the only LLM
  path, so a master switch would just turn LLM off entirely; not worth the
  fan-out-to-live-sandboxes code. (Reversible later if ops wants one.)
- `apps/api/src/shared/account-limits.ts:81-85` — `accountEntitledToLlmGateway` is no
  longer a provisioning gate (every account must reach *some* LLM). Entitlement/tier
  becomes a **per-request gate inside the gateway billing path** (already exists).
  Remove as provisioning gate.
- Frontend: `model-selector.tsx`, `project-provider-modal.tsx`, `customize-overlay.tsx`,
  `secrets-view.tsx`, `use-opencode-sessions.ts`, `settings-view.tsx` — treat
  `llm_gateway` as always-true; drop the native-vs-gateway UI fork and the `native`
  cache-key scope.

### Triplicated / duplicated logic → single helpers
- `resolveLlmGatewayBaseUrl` is copy-pasted in `sandbox-env-sync.ts:266`,
  `session-sandbox.ts:350`, `warm-pool.ts:542`. Extract one shared helper; after
  proxy deletion it's just `config.LLM_GATEWAY_BASE_URL || \`${KORTIX_URL}/v1/llm\``.
- Gateway-env injection block (`KORTIX_LLM_API_KEY`/`_BASE_URL`) is built three times →
  one `buildGatewayLlmEnv(token, baseUrl)` helper. Delete vestigial `KORTIX_YOLO_*`.

---

## 7. Reliability hardening (fold in the audit findings)

Priority order — these are the reasons "it doesn't work reliably" today:

1. **Durable usage/billing (highest impact).** Today `recordUsage`/wallet-debit runs
   after the response, `void`-ed, failures swallowed → silent revenue loss on pod
   kill or RPC failure. Fix: write a **usage ledger row transactionally in `settle`**
   (or to a durable queue) with idempotency key = request id; a reconciler debits
   wallets from the ledger with retry. No charge is ever only-in-memory.
2. **Fail-closed pricing.** Managed `pricingRef` cross-provider matching can resolve
   to no pricing → billable turn charged **$0** (Fusion, the AUTO default, is the
   worst case). Fix: if a managed model has no resolved price, **block at startup /
   hard-error the request**, never silently bill $0. Pin managed prices in the
   catalog rather than depending on models.dev slug coincidence.
3. **Entitlement as a per-request gate.** With no toggle/dual-mode, the whole
   "entitlement bypass on live-toggle/per-prompt" bug class disappears. Tier/spend
   checks live only in the gateway billing gate, evaluated every request.
4. **Shared circuit-breaker state.** Breaker is per-pod today (open on one replica,
   closed on another; half-open thundering herd). Move breaker state to a shared
   store (Redis) with a single-probe half-open.
5. **Trace on control-plane failure.** `authorize`/`resolveUpstream` throwing yields
   an opaque 503 with **no trace row** → API-down incidents invisible. Always write a
   trace, even on infra error.
6. **No kill-switch.** `LLM_GATEWAY_ENABLED` / `LLM_GATEWAY_DEFAULT_ENABLED` deleted
   (decision §10). Nothing to fan out.

---

## 8. Catalog as the single source of truth

- `MANAGED_MODELS` (+ generated BYOK `CATALOG`) stays the one definition. Good.
- **Move tier/free gating server-side** so the picker can't drift: today
  `/projects/:id/llm-catalog` serves the full catalog and the frontend gates
  visibility, so a free user can *see* premium models then 4xx at send. Serve a
  catalog already filtered to what the principal's tier can use (or annotate each
  entry with `entitled: boolean` + reason) so the picker shows the truth.
- **Self-host / no managed keys configured → hide managed models** (decision §10).
  If `OPENROUTER_API_KEY` / `AWS_BEDROCK_API_KEY` are unset, the catalog must not
  advertise the models they'd serve — only show BYOK providers the user connected
  (+ the free Zen tier, which needs no key). The picker never shows an unservable
  model. Implement as a server-side filter keyed on which managed upstreams have a
  configured key.
- **Drop `google`** from the selector provider list until there's a real transport —
  it's advertised but unservable (`@ai-sdk/google` isn't OpenAI-compatible).
- Keep **connection-authoritative visibility** (add key → provider connected →
  models appear) — it already works via project secrets; it just no longer needs any
  sandbox round-trip.

---

## 9. Migration plan (phased, each phase shippable + reversible)

**Phase 0 — prereq.** Migrate preview/ephemeral k8s envs (`infra/k8s/envs/preview`)
off `LLM_GATEWAY_PROXY_TARGET` onto in-API or standalone. *Blocks proxy deletion.*

**Phase 1 — make gateway unconditional.** Delete the opt-in gate (§6 experimental):
`projectLlmGatewayEnabled` → true everywhere; remove the catalog 404 gate, the
toggle fanout, the frontend native/gateway fork. Both code branches still exist but
the native arm is now dead. Ship; verify managed + BYOK both route through gateway
for every project.

**Phase 2 — keys stay server-side.** Stop propagating `PROVIDER_CREDENTIAL_ENV`
secrets to sandboxes; make the deny-list + `enabled_providers:['kortix']`
unconditional; delete `applyLlmGatewayMode`'s native branch. Verify add-key works
with no sandbox restart.

**Phase 3 — collapse deployment + dedupe.** Delete proxy mode (`wire.ts:44-88`,
config, .env). Extract the single base-URL + gateway-env helpers; delete the three
copies and the propagate/mark mode machinery. Delete `KORTIX_YOLO_*`.

**Phase 4 — reliability.** Durable usage ledger + reconciler; fail-closed pricing
(pin managed prices); shared breaker; trace-on-error. This is the "works reliably"
phase and can land independently.

Do the work in a worktree per branch; Phases 1–3 are mostly deletion and should
shrink the codebase substantially.

---

## 10. Decisions (resolved 2026-06-26)

- **No kill-switch.** Delete both `LLM_GATEWAY_ENABLED` and
  `LLM_GATEWAY_DEFAULT_ENABLED`. The gateway is the only LLM path. Reversible later.
- **Drop per-member personal provider keys.** Provider keys are project-shared only
  (`owner_user_id IS NULL`) — which is exactly what the gateway already reads. The
  personal-override mechanism stays for **non-LLM** secrets; remove the ability to
  set a *personal* override on a `PROVIDER_CREDENTIAL_ENV` name (or simply stop the
  gateway/UI from surfacing it for provider creds).
- **Self-host with no managed keys → hide managed models** in the catalog (see §8).
- **Codex/ChatGPT subscription path** (OAuth `CODEX_AUTH_JSON`, server-side refresh)
  stays as-is — already gateway-routed and server-side. In scope, unchanged.

---

## 11. Clean server-side resource API (side-effects encapsulated)

The companion goal: stop scattering "now restart / now propagate / now refresh"
across routes and the client. **Mutations own their side-effects, server-side.** The
client states intent (+ optionally "I'm doing this from session X"); the *server*
decides whether that means propagate, refresh, restart, or nothing — and tells the
client what it did.

### The problem today
- `/v1/projects` is **one Hono app split across r1–r10** by file convention only — no
  resource boundary. Secrets live in `r3.ts`; sessions are smeared across `r7.ts`
  (CRUD), `r8.ts` (start/restart/presence), `public-shares.ts`, plus
  `session-lifecycle/` and `shared.ts`. Models = one `llm-catalog` GET in `r4.ts`.
- The side-effect *mechanism* is already centralized (`sandbox-env-sync.ts` → one
  `/kortix/env` daemon contract), but the **triggers are smeared across 9 call
  sites**, each independently choosing the `refreshModels` flag, all but the
  prompt-time one fire-and-forget `void`.
- **No server-side model state exists.** Default model is fire-and-forget'd into the
  *sandbox's* `opencode.jsonc` (`/kortix/preferences/model`); visibility pins,
  per-session model, recents all live in one localStorage blob
  (`opencode-model-store-v1`). Nothing follows the user across devices.

### Target: resource modules + a single side-effect owner
Reorganize the relevant resources into self-contained modules (router = thin
validate+authz; service = owns the mutation **and** its effect):
```
apps/api/src/projects/secrets/   → router + SecretsService
apps/api/src/projects/models/    → router + ModelPreferencesService (+ catalog serving)
apps/api/src/projects/sessions/  → router + SessionService (absorb r7/r8/lifecycle/shared)
apps/api/src/projects/_effects.ts → projectStateChanged(projectId, change, {session?})
```
`projectStateChanged` is the **only** thing that talks to `sandbox-env-sync`. The 9
hand-rolled `propagate…(refreshModels: isGatewayManagedEnv(name))` call sites are
deleted; services emit a typed `change` and the effect owner maps it to the effect.

### The side-effect contract (intent → effect)
Every mutation maps to exactly one effect, decided server-side. In the gateway-only
world most collapse to **nothing**, which is the whole point:

| Mutation | Effect with no session ctx | Effect with `apply:{sessionId}` |
|---|---|---|
| Set/delete **provider key** (BYOK) | none to sandbox (keys are server-side); return updated connected-providers | refresh that session's model list — cheap `/kortix/refresh?restart=0`, **no restart** |
| Set/delete **non-provider runtime secret** (MCP / app env) | best-effort env push to active sandboxes | **awaited** env push to that session; restart **only if** the secret needs a process restart |
| Set **default model** / visibility pins | persist; nothing to sandbox | session adopts on next turn; no restart |
| Patch **session config** | persist | apply to runtime, awaited, return new session state |

> Why this is clean either way: the *service* decides the effect from the
> architecture. If we were native, "set provider key" would restart the session; in
> gateway-only it doesn't. **The client code is identical regardless** — it just
> sends intent and reads back what happened. That's the encapsulation win.

### Endpoint shape — optional `apply` context on every mutation
```
POST   /v1/projects/:id/secrets        { name, value, scope, apply?: { sessionId } }
DELETE /v1/projects/:id/secrets/:name  ?session=<id>
PUT    /v1/projects/:id/models/default { providerID, modelID, apply?: { sessionId } }
PUT    /v1/projects/:id/models/visibility { entries:[{providerID,modelID,visibility}] }
PATCH  /v1/projects/:id/sessions/:sessionId   { …config }
```
Mutation responses carry what the server did, e.g.
`{ secret, applied?: { sessionId, action: 'none'|'refreshed'|'restarted' } }`, so the
**client never issues a separate restart call**.

### Model preferences get a real server home
New `ModelPreferencesService` + DB storage (per-user, optionally per-project):
- **`default_model`** — replaces the `/kortix/preferences/model` → `opencode.jsonc`
  fire-and-forget. Authenticated, durable, cross-device.
- **visibility pins** (`show`/`hide`) — the "Manage models" set, server-side so it
  follows the user. (Connection-authoritative visibility stays derived from project
  secrets — already server-truth, no migration.)
- Stays client-only: `recent`, per-session model/agent (keyed by session UUID),
  `variant`. Ephemeral UI state; cheap to lose. (Optionally fold per-session model
  into the `project_sessions` row later for reload fidelity — not required.)

### Bonus reliability win
With provider keys no longer pushed to sandboxes, the **per-prompt awaited
`syncSandboxEnvForPrompt`** shrinks: it only needs to push *non-provider* secrets,
and only when a revision changed — not the full env on every turn. Faster turn start,
fewer moving parts.

This section slots in **after Phase 2** (once keys stay server-side, the secret
side-effect collapses and the clean contract becomes natural): add a **Phase 2.5 —
resource-module + effect-owner refactor**, then **Phase 5 — model-preferences server
home**.
