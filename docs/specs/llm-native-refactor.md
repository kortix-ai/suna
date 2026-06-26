# LLM: Rip out the gateway, go opencode-native — Spec

> Status: **proposal** · 2026-06-26 · Supersedes `llm-native-refactor`'s predecessor
> `llm-gateway-refactor.md` (gateway-only — abandoned after it failed in testing:
> Zen/managed/BYOK all broke, "Model not found" on fresh models).
>
> **North star:** opencode already handles models-via-API-key natively. Kortix's job
> shrinks to **(1) ingest the key**, **(2) keep one slim endpoint for managed models**,
> **(3) reload opencode on change.** Delete the heavy custom gateway. Nothing clever.

---

## 0. Decision

**Rip out the heavy LLM gateway. Rely on opencode-native provider/model handling.**

- **BYOK** (user's own Anthropic/OpenAI/OpenRouter/… key) → inject the provider's
  canonical env var into the sandbox; opencode auto-detects the provider and
  auto-lists its full model catalog. **No Kortix request path at all.**
- **Managed Kortix models** → keep ONE slim `kortix` OpenAI-compatible provider in
  opencode's config, pointed at a **slim Kortix `/chat/completions` endpoint**
  (executor token; **OpenRouter for most models + Bedrock for managed Claude** [LOCKED];
  credit metering). This is the OG 0.9.68 `/v1/router` shape + a Bedrock branch — NOT
  the heavy pipeline (no failover / breaker / resilience / transport registry).
- **The one new thing:** a clean **env-sync API** — set a key / default model (with an
  optional `sessionId`) → write the sandbox env/config → **reload the opencode
  instance** so it takes effect. No manual sandbox restart.

Why: opencode natively does everything the 4,400-LOC gateway engine does for
provider/key/model handling. The gateway is ~7,000 lines of liability (the audit's
billing-loss, $0-pricing, per-pod-breaker, opaque-503 bugs) that we don't need.

---

## 1. How opencode handles models natively (the foundation — verified in the fork)

Source: `anomalyco/opencode`. All paths below are in that repo.

1. **Keys come from 3 sources, merged** (`packages/opencode/src/provider/provider.ts:1313-1635`):
   - **Per-provider ENV VAR** (`:1488-1499`) — the var name comes from the models.dev
     catalog's `env` field, so `anthropic→ANTHROPIC_API_KEY`, `openai→OPENAI_API_KEY`,
     `openrouter→OPENROUTER_API_KEY`, `google→GEMINI_API_KEY`, etc. Set it → provider
     lights up with its **full models.dev model list**, zero model config.
   - **`auth.json`** (`packages/opencode/src/auth/index.ts`) — `api`/`oauth`/`wellknown`
     shapes; injectable wholesale via the **`OPENCODE_AUTH_CONTENT`** env (`:59-63`).
     (Kortix's existing `credentials/codex.ts` already produces this shape.)
   - **Config** `provider.<id>.options.apiKey` (custom provider block).
2. **Model catalog** = models.dev (`packages/core/src/models-dev.ts`), with build-time
   bake + `OPENCODE_MODELS_PATH`/`OPENCODE_DISABLE_MODELS_FETCH` overrides.
3. **List API** the web app reads: `GET /config/providers` → `{providers, default}`
   (`.../httpapi/handlers/config.ts:24-30`) = exactly the providers that got a key.
4. **Custom provider via config**, injectable without a file via **`OPENCODE_CONFIG_CONTENT`**
   env (`packages/opencode/src/config/config.ts:467-474`) — a new id (e.g. `kortix`)
   defaults to `npm:@ai-sdk/openai-compatible`. `enabled_providers` is a hard allowlist.
5. **THE VALIDATION (the bug)** — `provider.ts:1777-1799` `getModel`: every prompt
   validates `providerID/modelID` against the **per-instance cached** `provider.models`
   map; an unlisted id → `ModelNotFoundError` "Model not found … Did you mean …". There
   is **no passthrough** and no disable flag — opencode needs the model entry to resolve
   `api.id`/npm/options.
6. **Env + provider state are snapshotted ONCE per instance** (`env/index.ts:22`,
   `effect/instance-state.ts` infinite cache). A key/model change is **not** seen live.
   **BUT** opencode has a native **instance reload** (`.../httpapi/lifecycle.ts` +
   `instance-store.ts:126-145` `reload` → `runDisposers` → rebuild) that re-snapshots env
   and re-reads config **without a full process restart** — triggered by `PUT /config`
   or the `instance.dispose` endpoint. **This is our reload primitive.**

→ The "Model not found until restart" bug = (cached model map) × (map fed only by the
gateway catalog). Fix = keep the advertised catalog complete **and** reload the instance
on change. Both cheap.

---

## 2. Target architecture

```
SANDBOX (opencode, native)
 ├── BYOK provider(s):  env ANTHROPIC_API_KEY / OPENAI_API_KEY / …   ──▶ provider directly
 │     (opencode auto-detects + auto-lists models from models.dev; NO Kortix hop)
 └── `kortix` provider (OpenAI-compatible, config-injected):  baseURL=<slim>, apiKey=<executor token>
                                                   │
                                                   ▼
KORTIX API  — slim  POST /v1/router/llm/chat/completions  +  GET /models
   (auth executor token · route by model: Bedrock(Claude) | OpenRouter(rest)
    · extractUsage + calculateCost + deduct credits · rate-limit)
                                   ├──▶ Bedrock     ──▶ managed Claude
                                   └──▶ OpenRouter  ──▶ Fusion / DeepSeek / … (managed)
```

- **Two managed upstreams (LOCKED): Bedrock for Claude, OpenRouter for the rest.**
  Salvage ONLY the Bedrock + openai-compat request/response mapping from the old
  transports (the pure payload shaping) — drop everything else (failover, breaker,
  resilience, registry, the standalone pod). Simple model→upstream switch.
- **BYOK never touches Kortix** — the user's key + opencode + the provider. No metering
  (it's their cost), no failover, no breaker. Just works.
- **Managed billing** lives only in the slim endpoint (it already does `deductLLMCredits`).

### The env-sync API (the one new thing)
The daemon rail already exists: `POST /kortix/env` (`apps/kortix-sandbox-agent-server/src/routes/env.ts:106`).
Repoint it:
```
POST /kortix/env {
  revision,
  env: { ANTHROPIC_API_KEY?, OPENAI_API_KEY?, …,        // BYOK provider keys (NO LONGER stripped)
         OPENCODE_CONFIG_CONTENT?, OPENCODE_AUTH_CONTENT? },
  defaultModel?,            // → opencode `model` / per-session model
  sessionId?,               // scope the reload to a session if given
  reload: true
}
→ daemon writes env/config/auth → triggers an opencode INSTANCE RELOAD
  (prefer instance.dispose / PUT /config — soft, no process restart; fall back to restart)
```
Kortix API side: when a project secret (provider key) or the default model changes,
call this with the changed env + `sessionId` (from the chat input context) + `reload:true`.

---

## 3. The "Model not found" fix (both levers)

- **(a) Keep the managed catalog complete.** The `kortix` provider's `models` map (in the
  injected `OPENCODE_CONFIG_CONTENT`) must list every managed id we advertise — sourced
  from the **kept** `gatewayModelCatalog()`. BYOK is free (models.dev provides the list).
- **(b) Reload on change** via §2's env-sync → opencode's native instance reload (not a
  process restart). This is the real fix for "fresh model 404s until restart."
- *Optional later:* a tiny opencode patch so an unlisted id on an `@ai-sdk/openai-compatible`
  provider falls through as a synthesized pass-through model (`getModel` when
  `provider.source==='config'`). Only if we don't want to ship a full catalog. **Not v1.**

---

## 4. What to rip out (DELETE)

- `packages/llm-gateway/**` (~4,410 LOC engine: pipeline, resilience, catalog, failover,
  breaker). **Carve out FIRST** (into the slim endpoint): `usage/extract.ts` +
  `usage/pricing.ts` (billing math) AND the `transports/bedrock/*` + `transports/openai-compat/*`
  **request/response payload mapping** (reused by the slim endpoint's two upstream branches).
  Delete the rest of `transports/` (registry, anthropic-direct, openai-responses) + all of
  pipeline/resilience/failover/breaker.
- `apps/llm-gateway/**` (the deployed pod) + `infra/k8s/charts/kortix-gateway/` + `LLM_GATEWAY_*` values.
- In `apps/api/src/llm-gateway/`: `wire.ts`, `internal-routes.ts`, `internal-auth.ts`,
  `breaker-store.ts`, `breaker-reconciler.ts`, `resolution/resolve-candidates.ts`,
  `resolution/descriptors.ts`, `sandbox-llm-env.ts`. Unwire `mountLlmGateway`
  (`apps/api/src/index.ts:655`) + `startGatewayBreakerReconciler`. Remove `/gateway/playground`.
- In `opencode.ts`: the `enabled_providers:['kortix']` allowlist and the
  `KORTIX_OPENCODE_DENY_ENV` credential-strip (we now WANT provider keys in the sandbox).
- Env vars: `KORTIX_LLM_*`, `LLM_GATEWAY_*`, `GATEWAY_INTERNAL_TOKEN`, `GATEWAY_RETRY_*`/`BREAKER_*`.
- Most of my abandoned PR #3849 work in this area (gateway-only) goes with it.

## 5. What to KEEP / TRIM

- **KEEP** — model catalog **data** (`models/catalog-models.ts` `gatewayModelCatalog`,
  `@kortix/shared/llm-catalog`, the `/llm-catalog` route); executor-token minting
  (`mintExecutorToken` — our "ingest the key" rail); Codex/ChatGPT OAuth credential
  resolution (`credentials/` → materialize opencode `auth.json`).
- **TRIM** — billing/credits core (`recordGatewayUsage`/`deductForLlmUsage`/`recordUsageEvent`,
  `budgets.ts`): keep the metering, drop the pipeline binding. ⚠️ Re-home usage metering
  onto the slim endpoint (today the spend dashboards read `gateway_request_logs`, which
  only the deleted gateway writes).
- **REVIVE/TRIM as the managed endpoint** — `apps/api/src/router/routes/session-llm.ts`
  (`/v1/router/llm`): already OpenAI-shaped `/chat/completions` + `/models`, proxies to
  OpenRouter, meters credits, rate-limits, auths the executor token. This becomes THE
  slim managed endpoint. No transports/failover/breakers.
- **DELETE [LOCKED]** — the "Kortix as an OpenAI-compatible gateway *product*" surface:
  `apps/api/src/llm-gateway/gateway-keys.ts`, `public-url.ts`,
  `apps/api/src/projects/routes/gateway.ts` (keys/budgets/logs/overview/playground),
  FE `apps/web/src/components/projects/gateway/*` + `hooks/projects/use-project-gateway.ts`,
  and the `kortix.gateway_api_keys` table usage. Not sold as a standalone gateway → gone.

- **KEEP [LOCKED]** — the per-user model-preferences server store from the prior work
  (the `user_model_preferences` migration + `/v1/me/model-preferences` endpoints + the
  use-model-store wiring): it's gateway-independent and useful. Carry it forward.

## 6. Phases

0. **Spec sign-off** (this doc).
1. **Managed endpoint**: confirm/trim `/v1/router/llm` to serve the full managed catalog
   via OpenRouter with credit metering + the executor token. Point a `kortix` openai-compat
   provider at it. (Verify a managed model completes + meters.)
2. **BYOK native**: stop stripping provider keys; remove `enabled_providers:['kortix']`;
   inject canonical env vars from project secrets. (Verify add-key → provider+models appear.)
3. **Env-sync + reload**: repoint `/kortix/env` to write native env/config + trigger
   opencode instance reload (soft); thread `sessionId` from the chat input. (Verify
   add-key/change-model → usable with no manual restart, no "Model not found".)
4. **Rip out**: delete the heavy gateway (§4) once 1-3 are green. Re-home metering.
5. **Frontend**: model picker reads opencode's `/config/providers` (native list) +
   the managed catalog; drop the gateway-mode UI.
6. **Verify e2e + clean up env/k8s.**

## 7. Decisions (resolved 2026-06-26)
- ✅ **Managed upstreams: Bedrock for Claude + OpenRouter for the rest** (salvage their
  payload mapping into the slim endpoint).
- ✅ **Gateway *product* surface: KILL** (keys/budgets/public endpoint/FE gateway pages).
- ✅ **Model-prefs server store: KEEP** (carry the migration + `/v1/me` forward).
- Still open (implementation detail, not blocking): **metering re-home** — emit usage from
  the slim endpoint into `usage_events` (keep the Phase-4 idempotency) and repoint any spend
  surfaces off `gateway_request_logs` before deleting the gateway that wrote them.
