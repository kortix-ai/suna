# `apps/api` Roadmap — Execution Playbook

Companion to [AUDIT.md](./AUDIT.md). This is the **conflict-aware, ready-to-run** plan. Anchors are symbol/function names (line numbers drift). Verified against the working tree on `newer-kortix`.

## Baseline & go-conditions
- `tsc --noEmit` is **green** on both `apps/api` and `packages/db` (the in-flight git-connections call-site migration is finished).
- **GO when:** the in-flight WIP is committed or stashed (so checkpoints don't bundle it) and `projects/index.ts` is not being actively edited.
- Per step: implement → `tsc --noEmit` green → run relevant `bun test` → **commit** (no `Co-Authored-By` trailer). Branch: `api/quality-roadmap` off the green HEAD.

## ⛔ No-go zone until the git-connections feature merges
The feature (`supabase/migrations/00000000000059_project_git_connections.sql` + `project_git_connections`/`project_git_credentials` tables, dual-write migration) is actively rewriting these — **do not touch in Wave A**:
- `apps/api/src/projects/index.ts` (esp. git-auth region: `getProjectGitRemote`/`hasServerManagedGitAuth`/`resolveProjectGitAuth` + write paths)
- `apps/api/src/projects/github.ts`, `apps/api/src/projects/freestyle-git.ts`, `apps/api/src/projects/git.ts`
- `packages/db/src/schema/kortix.ts`, `packages/db/src/index.ts`, `packages/db/src/types.ts`

**Tier 3.1 is SUPERSEDED** → re-scoped (see Wave B): build the typed provider strategy *on* the new connections model, don't refactor the old `metadata.git` parser (it's becoming a legacy fallback).

---

## WAVE A — feature-orthogonal (run now, in this order)

### A0 — error infra prerequisites (tiny, unblocks A3)
- `errors.ts`: add `export function httpError(status: ContentfulStatusCode, message: string): never { throw new HTTPException(status, { message }); }` and `export class ForbiddenError extends HTTPException { constructor(m='Forbidden'){ super(403,{message:m}); } }`.
- `index.ts` `onError` (~:348): migrate the `BillingError` branch from `{ error: err.message }` → `{ error: true, message: err.message, status: err.statusCode }` (canonical shape; 402 must carry `message` for the web billing UI).
- `apps/web/src/lib/platform-client.ts:271`: change `body?.error || body?.message || …` → `body?.message || (typeof body?.error === 'string' ? body.error : null) || …` (else it throws the literal string `"true"`).
- Verify: `tsc` green. Commit: `refactor(api): add httpError/ForbiddenError + canonicalize BillingError response`.

### A1 — Step 2.x: proxy unification + **billing bug fixes** (highest value, fully orthogonal)
- Scope: `router/routes/proxy.ts` (1214L, 105 `if`) + new `router/services/sse.ts`; delegate to existing `services/anthropic.ts` `extractAnthropicUsage` + `services/llm.ts` `extractUsage`.
- 2.1 collapse the 4 billing fns (`billLlmKortixProxy`, `extractUsageFromKortixProxyStream`, `billLlmPassthrough`, `extractUsageFromPassthroughStream`) → one `billLlm(…,{markup,actor})` + one `extractUsageFromStream(…)`.
- 2.2 **FIX OVERBILLING:** passthrough stream must read cache tokens; stop hand-rolling the inferior Anthropic parser — use `extractAnthropicUsage`.
- 2.3 extract `router/services/sse.ts` (the 5× duplicated SSE framing).
- 2.4 token-extractor loop in `tryAuthenticate`; gate the full-body token sniff behind a per-service flag.
- Verify: `tsc` green + `bun test src/__tests__/billing/*.test.ts` + any router tests. **Add a regression test for cached-token billing if absent.**
- Commit: `refactor(router): unify proxy billing/SSE paths; fix cached-token overbilling`.
- **Checkpoint-pause for review** (touches real billing math).

### A2 — Step 1.1: delete IAM legacy bridges (~120 lines, orthogonal)
- Pre-check (BLOCKING): confirm no code inserts `account_members`/`project_members` without calling its `membership-sync` fn. If a path does, fix *that* (call sync) — do not keep the bridge.
- `iam/engine.ts`: delete `bridgeLegacyAccountRole`, `bridgeLegacyProjectRole`, `getSystemRoleActions`, `SYSTEM_ROLE_PERMISSION_CACHE`, `invalidateSystemRoleCache`, `LEGACY_MEMBER_ACCOUNT_READS`, and the `projectMembers` branch in `listAccessibleResources`. `authorize()` → token → super-admin → policies → deny. `resolveActor` drops the now-unused `accountRole`.
- Also fixes confirmed bug #3 (dead `invalidateSystemRoleCache`).
- Verify: `tsc` + `bun test` (any iam/authz tests) + spot-check authz via the e2e spec's role matrix.
- Commit: `refactor(iam): delete legacy authz bridges now superseded by policy materialization`.
- **Checkpoint-pause for review** (security-sensitive).

### A3 — Step 0.3: error-contract codemod (everywhere EXCEPT `projects/index.ts` + `oauth/index.ts`)
- Targets (~207 of 363, projects/index.ts's 156 deferred to Wave B): `accounts/iam.ts` (50), `accounts/index.ts` (35), `accounts/invites.ts` (7), `sandbox-proxy/routes/share.ts` (10), `tunnel/*` (~26), `servers/index.ts` (6), `queue/routes.ts` (6), `channels/slack-webhook.ts` (6), `billing/*`, `deployments/*`, etc.
- Mapping (preserve exact message + status):

  | status | replacement |
  |---|---|
  | 400 | `throw new ValidationError(msg)` |
  | 401 | `throw new HTTPException(401,{message:msg})` |
  | 403 | `throw new ForbiddenError(msg)` |
  | 404 | `throw httpError(404, msg)` — **NOT `NotFoundError`** (it rewrites the message) |
  | 409 | `throw new ConflictError(msg)` |
  | 410/429/500/502/503 | `httpError(<status>, msg)` (503 auto-gets `Retry-After`) |

- **EXCLUDE `oauth/index.ts` entirely** (28 OAuth2-spec `{error:'invalid_client',error_description}` responses — `error` is a spec code, not a message).
- Per file: convert, then `tsc` green. Commit per logical group, e.g. `refactor(accounts): route errors through global handler`. Final body shape is `{error:true,message,status}` (consumers already read `message`; CLI + web central client safe).
- Verify after the wave: e2e spec `SEC-E`/`SYS-5` (404 shape) + a couple converted endpoints return `{error:true,...}`.

### A4 — Step 0.4: zValidator on orthogonal routers
- Adopt `zValidator('json'|'query'|'param', schema)` (`@hono/zod-validator`; reference: `deployments/routes/deployments.ts`). Targets: `billing/routes/subscriptions.ts` (10), `accounts/iam.ts` (9), `accounts/index.ts` (7), `tunnel/*`, `servers/index.ts`, `queue/routes.ts`, `platform/routes/api-keys.ts`, `setup/index.ts`. **NOT `projects/index.ts` (31 — Wave B).**
- Deletes `(body as any)`, the per-file `is required`/`typeof` checks, and the duplicate `normalizeString` in `accounts/index.ts:218` (keep one canonical or replace with zod). Validator failures route through A0/A3 handler.
- Commit per router group: `refactor(<area>): validate request bodies with zod`.

### A5 — Step 0.2 (partial): adopt `requirePermission` in `accounts/iam.ts`
- `iam/middleware.ts` `requirePermission(action, getTarget?)` already exists (0 route usages). Apply as route middleware to the ~14 target-free + ~6 resource-scoped IAM handlers; delete their `assertAuthorized` preambles. (The `withProject` half is Wave B — it's in `projects/index.ts`.)
- Commit: `refactor(iam): declarative requirePermission middleware on IAM routes`.

### A6 — Tier 4 orthogonal splits
- **4.3** split `accounts/iam.ts` (1050) → `iam/routes/{groups,policies,roles,members}.ts` + shared `serializers.ts` (kills ~25× hand-written DTO maps) + `_shared.ts` helpers. (Compose with A3/A4/A5 on these handlers to avoid double-touching.)
- **4.4** `middleware/auth.ts`: extract pure `resolveToken(token): ResolvedAuth` discriminated union; `supabaseAuth`/`combinedAuth`/`apiKeyAuth` differ only in token extraction + side effects. Removes the duplicated JWT local-verify-then-network dance (twice in full).
- **4.5** `config.ts`: move pricing (`KORTIX_MARKUP`, `TOOL_PRICING`, `LLM_PRICING`, `getToolCost`, `calculateLLMCost`) → `billing/pricing.ts`; add the 18 `KORTIX_*` keys read via `(config as any)` to the envSchema (kills 10 casts + brings them under startup validation).
- Cast sweep (0.1 cont.): remove `c.get(...) as string` / `(c as any)` in the orthogonal files now that `AppEnv = AuthVariables`.
- Commit per file: `refactor(<area>): split <file> / extract <thing>`.

---

## WAVE B — gated on the git-connections feature merging

Run only after the feature lands and `projects/index.ts` is stable.
- **1.3** delete duplicate local `parseGitHubRepoUrl` in `projects/index.ts` (import from `github.ts`); consolidate SHA-1/UUID regexes → `shared/validation.ts`.
- **0.3 (cont.)** error-contract codemod on `projects/index.ts` (156).
- **0.4 (cont.)** zValidator on `projects/index.ts` (31).
- **0.2 (cont.)** `withProject(level)` middleware across the 61 `loadProjectForUser` sites (sets `c.var.project`, throws 404/403); fixes the split-brain 403-vs-null contract.
- **Tier 3.1 (re-scoped)** typed provider strategy **on the connections model**: convert the `if (provider===… && authMethod===…)` chain in `resolveProjectGitAuth` + `hasServerManagedGitAuth` to a `Record<provider, GitAuthStrategy>` table keyed off the typed `project_git_connections.provider`/`auth_method` columns; type `ProjectGitRemote.provider/authMethod` as unions matching the DB vocabulary. Then **delete** the dual-write to `metadata.git` and the trailing `PROJECT_GIT_AUTH_SECRET_NAME` fallback (one-line removals once strategy exists).
- **4.2** split `git.ts` (1557) → `git/{exec,mirror,read,history,merge}.ts` + extract the non-git TOML parser to `projects/kortix-config.ts`; fold `runGitCapture` into `runGit` (options object); dedup the byte-identical name-status/numstat parsing.
- **4.1** decompose `projects/index.ts` → sub-routers (`sessions/triggers/apps/change-requests/files/secrets/github-install/channels/access/snapshots`, <500 each) mounted on `projectsApp`; extract the cron scheduler to `trigger-scheduler.ts`; dedup the fire-and-forget provisioning IIFE. **4.6** carve `projects/repositories/`. `index.ts` → ~80-line assembler. Preserve the 6 escaping symbols (`projectsApp`, `projectWebhooksApp`, `start/stopProjectTriggerScheduler`, `createProjectSession`, `resolveGitTriggerActor`).
- **Checkpoint-pause for review** before 4.1 (the 5000-line decomposition).

---

## Current metrics (snapshot)
- legacy `{error:'string'}` responses: **363** (projects 156 / iam 50 / accounts 35 / oauth 28 *(excluded)* / share 10 / tunnel ~26 / …); canonical `{error:true}`: 38.
- `loadProjectForUser` sites: **61**; `assertAuthorized`: **41**; `requirePermission` route usages: **0**.
- `as any`: **159** total — `(c as any)` 23, `c.get(...) as` 82, `(config as any)` 10.
- validation: `zValidator` 0, `safeParse` 4, `is required` 85, `typeof !== 'string'` 30, `(body as any)` 17, `normalizeString` defined 2×.
- >1k-line files: `projects/index.ts` ~5245, `git.ts` 1557, `router/routes/proxy.ts` 1214, `accounts/iam.ts` 1050.

## Confirmed bugs (fix during the relevant step)
1. Cached passthrough LLM overbilled — `router/routes/proxy.ts` (fix in A1).
2. Anthropic cache tokens ignored by proxy's hand-rolled parser (fix in A1).
3. `invalidateSystemRoleCache` dead/never called — latent stale perms (removed in A2).
4. `loadProjectForUser` split-brain 403-vs-null (fixed in Wave B 0.2).
5. Snapshot rebuild failure writes `status:'ready'` with an error set — `snapshots/builder.ts` (standalone fix, orthogonal — can do in Wave A).
6. 18 `KORTIX_*` keys read via `(config as any)`, unvalidated at startup (fixed in A6/4.5).
