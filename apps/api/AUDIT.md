# `apps/api` — Thermo-Nuclear Code-Quality Audit

Maintainability audit of the API core (Hono/Bun). Line numbers are **as-of-audit** and drift; symbol/function names are the stable anchors. Evidence was gathered by reading the actual source, not summaries.

> **Execution plan → [AUDIT-EXECUTION.md](./AUDIT-EXECUTION.md)** — conflict-aware Wave A (feature-orthogonal, runnable now) / Wave B (gated on the in-flight git-connections feature). Read that before starting any step.

## Verdict: the API is **bimodal**, and the fix is mostly *deletion*, not abstraction

Two architectures coexist:
- **Good half** — `billing/`, `iam/engine`, `repositories/`, `config.ts`'s env layer: clean route→service→repository, Stripe behind `getStripe()`, zod-validated config, errors thrown to a global handler. `billing/routes/webhooks.ts` is 30 lines of pure delegation. **This is the target pattern.**
- **Legacy half** — `projects/`, `accounts/`, `oauth/`, `router/routes/proxy.ts`: 4930 / 1050 / 966 / 1214-line god-files that inline DB + business rules + crypto + HTTP, hand-roll every error response, validate by hand, and copy-paste their most security-sensitive logic dozens of times.

Almost every fix below **deletes** code and already has a proven in-repo pattern to copy. Realistic reduction across these items: **~1,500+ lines deleted (not relocated)** plus several real bugs fixed.

---

## Landed (PR #1 — type foundation + safe deletions)

- [x] **0.1 foundation** — `types.ts`: `AppEnv['Variables']` was `{userId, userEmail}` only → now `= AuthVariables` (the full set the auth middleware actually sets), plus the two missing fields `tokenProjectId` + `iamTokenId`. Makes every `Hono<AppEnv>()` handler's context honestly typed. *Verified `tsc --noEmit` clean.*
- [x] **1.2 (partial)** — deleted dead `countLegacySandboxesNeedingMigration` (zero callers anywhere) from `projects/legacy-migration.ts` + cleaned the orphaned `sql` import.

### Deferred (concurrent edit collision)
- [ ] **0.1 cont. / 1.3** — remove the 4 `(c as any)` context casts in `projects/index.ts` (`resolveProjectAccount`, `loadProjectForUser`, `fireProjectTrigger`) by typing those helpers `Context<AppEnv>`; delete the duplicate local `parseGitHubRepoUrl` (identical to the exported `github.ts` one) and import it. **Held: `projects/index.ts` was being actively edited during the audit (4930→5245 lines) and currently has 4 unrelated in-flight type errors (`hasServerManagedGitAuth` made `async`, callers not awaited). Apply once that settles.**

---

## TIER 0 — code-judo that deletes systemic complexity (cheap, do first)

- [x] **0.1 Type the Hono context** — *foundation landed.* Remaining: sweep the `(c as any)` (14×) and `c.get('userId') as string` (~68×) casts now that the type is honest.
- [ ] **0.2 Adopt the auth middleware that already exists and is never called.** `iam/middleware.ts` exports `requirePermission(action, getTarget?)` (routed through `authorizeCached`) — **zero call sites**. Meanwhile `loadProjectForUser(c,id,level)` + `if(!loaded) 404` is hand-copied **59×** in `projects/index.ts` and the `assertAuthorized` preamble ~20× in `accounts/iam.ts`. Introduce `withProject(level)` (sets `c.var.project`, throws 404/403 itself); adopt `requirePermission` for IAM routes. **~200 lines deleted; the most security-sensitive line stops being copy-pasted 80×.** Also fixes `loadProjectForUser`'s split-brain (throws 403 on account failure, returns null on project failure).
- [ ] **0.3 Route errors through the global handler that already exists.** `index.ts` `onError` + `errors.ts` classes emit `{error:true,message,status}`, but **359** responses use the legacy `c.json({error:'string'},4xx)` shape vs **38** canonical; the global handler is itself inconsistent (`BillingError`→`{error: msg}` string vs `HTTPException`→`{error:true,…}`). Throw `ValidationError`/`NotFoundError` instead; fix the `BillingError` branch. **~400 lines deleted; error contract becomes real (ties to e2e `SEC-E`/`SYS-5`).**
- [ ] **0.4 Use the zod validator already in deps.** zod is used in `config.ts` but `@hono/zod-validator` has **0 usages**; instead 88 `'… is required'` + 151 `typeof x !== 'string'` checks + `(body as any).x` + `normalizeString`/`normalizeBoolean` **duplicated** in `projects/index.ts` and `accounts/index.ts`. Adopt `zValidator('json', schema)` (`deployments/routes/deployments.ts` is the reference). **Deletes the `(body as any)` flood + dup helpers + ~240 manual checks.**

## TIER 1 — delete dead/redundant subsystems

- [ ] **1.1 Delete the IAM legacy bridges (~120 lines).** `backfill.ts` (every boot) + `membership-sync.ts` (every membership change) already materialize every `account_role`/`project_members` into real `iam_policies` — their headers say they exist *"so the engine never needs the legacy bridges."* Yet `engine.ts` still runs `bridgeLegacyAccountRole`/`bridgeLegacyProjectRole` in addition. The bridge can only fire when sync/backfill failed — i.e. it silently papers over data drift. `LEGACY_MEMBER_ACCOUNT_READS` hand-duplicates the `MEMBER` role's action list (two sources of truth). **After confirming no membership write skips its `sync*`, delete the bridges; `authorize()` collapses to token→super-admin→policies→deny.**
- [x] **1.2 `projects/legacy-migration.ts`** — dead `countLegacySandboxesNeedingMigration` removed. **Remaining:** the whole 606-line module has zero prod callers (only a test + a manual ops script) — quarantine or delete once the team confirms the prod backfill ran.
- [ ] **1.3 Duplicate definitions** — `parseGitHubRepoUrl` exists in both `github.ts` (exported) and `projects/index.ts` (local, identical) → delete local, import. SHA-1 regex `/^[0-9a-f]{40}$/` (6×) + ad-hoc `UUID_V4_REGEX` → `shared/validation.ts`.

## TIER 2 — `router/routes/proxy.ts`: one operation copy-pasted ~6× — and it's mis-billing

There is exactly one proxy operation (auth → build → reserve → forward → bill), parameterized by `mode` (markup + key-injection) and `service` (dialect + routes). The file expresses it as ~6 overlapping copies.

- [ ] **2.1** Four billing fns are one fn ×4 (`billLlmKortixProxy`, `extractUsageFromKortixProxyStream`, `billLlmPassthrough`, `extractUsageFromPassthroughStream`) differing only in a markup constant + log prefix. Collapse to one `billLlm(…, {markup, actor})` + one `extractUsageFromStream(…)`. **~400 lines, ~40 `if`s gone.**
- [ ] **2.2 CONFIRMED BILLING BUGS:** passthrough stream never reads cache tokens → cached OpenAI passthrough **overbilled**; the proxy hand-rolls an inferior Anthropic parser that ignores `cache_creation/read_input_tokens` while the correct `extractAnthropicUsage` already exists in `services/anthropic.ts`. Delegate to the existing parsers.
- [ ] **2.3** SSE framing reimplemented 5× (`proxy.ts` ×2, `llm.ts`, `anthropic.ts`, `session-llm.ts`) → `router/services/sse.ts`.
- [ ] **2.4** `tryAuthenticate` repeats validate-or-reject 5×, incl. cloning + reading the **entire request body** on every POST to sniff for a token. Loop over token extractors; gate body-sniff behind a per-service flag.

Target: **1214→~650 lines, 105→~45 `if`s, billing fixed.**

## TIER 3 — typed provider strategy (kills stringly-typed dispatch)

> **3.1 SUPERSEDED / RE-SCOPED → Wave B.** The in-flight `project_git_connections`/`project_git_credentials` feature already moves git auth into typed DB columns and demotes `metadata.git` parsing to a legacy fallback. Don't refactor the old parser — build the strategy table *on* the connection model, then delete the dual-write + legacy fallbacks. (3.2 proxy dialect is orthogonal → Wave A, folded into 2.x.) See AUDIT-EXECUTION.md.

- [ ] **3.1 Git auth** dispatched by string equality on untyped metadata across `getProjectGitRemote` / `hasServerManagedGitAuth` / `resolveProjectGitAuth`, each re-branching `provider`/`authMethod` in a different order with a silent `catch`→`none` (a typo fails silently). Define real unions + `Record<Provider, resolver>`. New providers = one map entry.
- [ ] **3.2 Proxy dialect** hardcoded as `service.name === 'anthropic'` (4×) instead of a `usageFormat` field in the `proxy-services.ts` config table; `maybeNormalizeOpenAIResponsesInput` → a `requestTransform` on the config entry.

## TIER 4 — decompose the god-files (after Tiers 0–1 make them splittable)

- [ ] **4.1 `projects/index.ts` (4930+, ~90 routes, 12 domains).** Only 6 symbols escape the file, so splitting into sub-routers mounted on `projectsApp` is invisible to callers. After 0.2 + a `projects/repositories/` extraction: split into `sessions/triggers/apps/change-requests/files/secrets/github-install/channels/access/snapshots` route modules (<500 each); pull the cron scheduler daemon (module-global timer + a `globalThis` hack + two unrelated background loops) into `trigger-scheduler.ts`; dedup the fire-and-forget provisioning IIFE copy-pasted in session-create and session-restart. `index.ts` → ~80-line assembler.
- [ ] **4.2 `git.ts` (1557)** = five modules in a trench coat (mirror cache / read / history / merge / a hand-rolled TOML parser that isn't even git). Split; fold `runGitCapture` into `runGit` via an options object (6 positional args incl. two booleans = transposition footgun); dedup the byte-identical diff-parsing at the two name-status/numstat sites.
- [ ] **4.3 `accounts/iam.ts` (1050)** — clean layering but 4 resources in one file (section banners already drawn). Split per resource; extract the policy/group/role DTO serializers (hand-written ~25×).
- [ ] **4.4 `middleware/auth.ts`** — `supabaseAuth` and `combinedAuth` are ~80% duplicate (the JWT local-verify-then-network-fallback dance appears twice in full). Extract a pure `resolveToken(): ResolvedAuth` discriminated union; each middleware just differs in where it reads the token.
- [ ] **4.5 `config.ts` (710)** — clean env layer, but smuggles a pricing module (`KORTIX_MARKUP`, `TOOL_PRICING`, `LLM_PRICING`, `getToolCost`, `calculateLLMCost`) → move to `billing/pricing.ts`. Also add the 18 `KORTIX_*` keys currently read via `(config as any)` to the envSchema (they bypass startup validation).
- [ ] **4.6 No route→service→repository layer in the legacy half** — `projects/`/`accounts/`/`oauth/` do DB inline (24/13/7 sites) while `billing/` proves the clean pattern; two DB clients (Drizzle + supabase-js) coexist, `projects/index.ts` imports both. Carve `projects/repositories/` + `accounts/repositories/`; restrict `getSupabase()` to genuine auth-admin ops.

---

## Confirmed bugs found during the audit (fix regardless of refactor)

1. Cached passthrough LLM calls **overbilled** — cache tokens dropped (`router/routes/proxy.ts` passthrough stream extractor).
2. Anthropic cache tokens ignored in proxy billing (proxy hand-rolled parser vs correct `services/anthropic.ts`).
3. `invalidateSystemRoleCache` has **zero callers** (`iam/engine.ts` comment claims `seedSystemRoles` calls it) → latent stale-permission incident.
4. `loadProjectForUser` split-brain: throws 403 on account-membership failure but returns `null` on project-access failure.
5. Snapshot rebuild failure writes `status:'ready'` **with** an error string set (`snapshots/builder.ts`) — a row state no other path produces.
6. 18 `KORTIX_*` config keys read via `(config as any)` are **never validated at startup** (`config.ts` envSchema gap).

## Recommended sequence (deletes complexity first)
1. 0.1 finish (cast sweep) + 1.3 dup deletions
2. 0.3 error contract (codemod) — biggest contract win
3. 0.4 zValidator — deletes `(body as any)` + dup helpers + ~240 checks
4. 2.1–2.3 proxy unification — fixes billing bugs, −~400 lines
5. 1.1 delete IAM bridges + 1.2 quarantine legacy-migration — −~700 lines
6. 0.2 `withProject`/`requirePermission` + Tier 3 provider tables
7. Tier 4 decomposition (extract `repositories/`, split god-files)
