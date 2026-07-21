# Codex/ChatGPT subscription billing-leak verification

Date: 2026-07-21
Scope: `suna-acp-harness-runtime-v2` worktree, branch `acp-harness-runtime-v2` (PR #4510)
Method: static control-flow trace (full handler bodies read end-to-end) + one empirical
HTTP probe against the running local stack. No live Codex/ChatGPT OAuth credential was
available, so the upstream-OpenAI leg of the trace is static-analysis only; everything
from the sandbox launch env through the router's auth/billing decision is either read
verbatim or confirmed live.

## Verdict: CONFIRMED LEAK (branch-only, not yet on production)

When a session runs the Codex ACP harness with a connected ChatGPT/Codex subscription
(`KORTIX_RUNTIME_AUTH_KIND=codex_subscription`), the user's stored `CODEX_AUTH_JSON`
OAuth token is **never read or used**. The codex-acp adapter is instead pointed at
Kortix's own `/router/openai` proxy using the sandbox's `kortix_sb_…` session token,
which the proxy treats as "Kortix-managed" (Mode 1): it injects **Kortix's own**
`OPENAI_API_KEY`/`OPENROUTER_API_KEY` upstream and **also deducts Kortix credits from
the user's wallet** at a 1.2× markup. This is the "second-worst" case named in the task:
Kortix's key pays OpenAI/OpenRouter for the tokens, and the user is billed Kortix
credits on top — despite having connected a subscription specifically so that
subscription (not per-token Kortix billing) would cover usage. Under one further
condition (pricing lookup miss on the codex model id — see Caveat below) this could
degrade further into a pure loss (Kortix pays upstream, $0 deducted from the user).

## Evidence chain (file:line)

### 1. Launch-time credential wiring — the crux

`apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`

- `AUTH_ENV_BY_KIND['codex_subscription'] = ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON']`
  (line 38) — these are the only two env vars `isolateHarnessAuthEnv` (lines 55-67)
  preserves for a codex-subscription session; `CODEX_API_KEY`/`OPENAI_API_KEY` are
  explicitly stripped (they're in `PROVIDER_CREDENTIAL_ENV`, line 20-32, but not in
  this kind's allow-list).
- `resolveAcpHarnessLaunchEnv(id: 'codex', env)`, lines 349-413:
  - `authKind === 'native_config'` branch (line 361) — not taken (BYOK-native case only).
  - `env.CODEX_API_KEY || env.OPENAI_API_KEY` branch (line 368) — **not taken**, because
    `isolateHarnessAuthEnv` already deleted both for `codex_subscription`.
  - `custom?.protocol === 'openai'` branch (line 377) — not taken (no `CUSTOM_LLM_*`).
  - Falls through to the final branch (lines 398-413), which is the **generic
    Kortix-gateway fallback used whenever there's no direct key**:
    ```
    DEFAULT_AUTH_REQUEST: JSON.stringify({
      methodId: 'gateway',
      _meta: { gateway: {
        baseUrl: `${apiUrl}/router/openai`,
        providerName: 'Kortix Gateway',
        headers: { Authorization: `Bearer ${token}` },   // token = KORTIX_TOKEN
      }},
    }),
    ```
  - **`CODEX_AUTH_JSON` is referenced nowhere in this function.** The developer's own
    comment at lines 357-360 confirms this is intentional: "Subscription auth is
    intentionally different: CODEX_AUTH_JSON stays server-side where the Kortix gateway
    can refresh it, and the adapter authenticates to that gateway with the sandbox
    token below." The bug is that "the gateway" it authenticates to
    (`apps/api/src/router`) never closes the loop back to the user's Codex credential —
    see step 3.
  - `token` here is `env.KORTIX_TOKEN` (line 280), i.e. the sandbox's
    `kortix_sb_<32 chars>` session key (documented at
    `apps/api/src/shared/crypto.ts:55`, "injected as KORTIX_TOKEN into sandbox"), **not**
    the user's OpenAI OAuth access token.

  Contrast with Claude (lines 493-501): for `claude_subscription`,
  `AUTH_ENV_BY_KIND` keeps `CLAUDE_CODE_OAUTH_TOKEN` (line 36), and the Claude branch's
  *first* check is `env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ||
  env.CLAUDE_CODE_OAUTH_TOKEN` — true, so it takes the **direct** branch and hands the
  OAuth token straight to the `claude-agent-acp` adapter as an env var, never touching
  `/router`. Structurally different, as the pre-existing context claimed — verified.

### 2. Where the request actually lands

`apps/api/src/index.ts:720` — `app.route('/v1/router', router)`. `KORTIX_API_URL`
passed into the sandbox includes `/v1` (test fixture at
`session-runtime-env.test.ts:17`: `apiUrl: 'https://api.kortix.test/v1'`), so
`${apiUrl}/router/openai` resolves to `.../v1/router/openai` — the exact mount point.

`apps/api/src/router/routes/proxy/routes.ts:5-6` wires every configured proxy service
(including `openai`) as a generic catch-all: `proxy.all('/openai/*', handleProxy)`.

### 3. Auth-mode selection strips any notion of "Codex"

`apps/api/src/router/routes/proxy/helpers.ts`, `tryAuthenticate()` (lines 23-123):
- Line 31: `if (bearerToken && isKortixToken(bearerToken) && config.DATABASE_URL)` —
  `isKortixToken` (`apps/api/src/shared/crypto.ts:37`) is `token.startsWith('kortix_')`,
  and `kortix_sb_` matches. This is the **first** check tried and it matches the sandbox
  token unconditionally.
- Line 33-36: `validateSecretKey(bearerToken)` resolves the token to `accountId` and
  returns `{ isKortixUser: true, accountId }` — **Mode 1**, no `isPassthrough` flag.
- **Empirically confirmed live**: `curl -X POST http://localhost:24508/v1/router/openai/responses -H "Authorization: Bearer kortix_sb_faketoken..."` → `{"error":true,"message":"Invalid Kortix token","status":401}`, i.e. the running stack takes exactly this `isKortixToken` branch (line 42, hard-reject on failed validation) for a `kortix_sb_`-prefixed bearer — proving the code path is live and reachable, not dead code.

`apps/api/src/router/routes/proxy/handlers.ts`, `handleProxy()` (lines 38-68):
- Line 51: `auth.isKortixUser && auth.accountId && !auth.isPassthrough` → true for the
  codex-subscription sandbox token → `handleKortixProxy` (Mode 1).

### 4. Whose key pays OpenAI — the smoking gun

`apps/api/src/router/routes/proxy/handlers.ts`, `handleKortixProxy()`:
- Line 103: `const kortixKey = service.getKortixApiKey();`
- `apps/api/src/router/config/proxy-services.ts:213-216` (the `openai` service entry):
  ```
  kortixTargetBaseUrl: config.OPENAI_API_KEY ? config.OPENAI_API_URL : config.OPENROUTER_API_URL,
  getKortixApiKey: () => config.OPENAI_API_KEY || config.OPENROUTER_API_KEY,
  ```
  This is **Kortix's own platform key** — never a per-user credential, and definitely
  never `CODEX_AUTH_JSON`.
- Lines 117-119: the original `Authorization` header (the sandbox's `kortix_sb_` token)
  is explicitly deleted before forwarding.
- Line 122: `injectApiKey(service, headers, body, /* useKortixInjection */ true)` →
  `apps/api/src/router/routes/proxy/helpers.ts:493-529` sets
  `Authorization: Bearer <kortixKey>` (line 504-505, `keyInjection.type === 'header'`,
  `prefix: 'Bearer '`) — Kortix's own key goes out on the wire to OpenAI/OpenRouter.

There is **no code anywhere in `apps/api/src/router`** that references
`CODEX_AUTH_JSON`, `resolveCodexCredential`, or `codex-core` — confirmed by
`grep -rln "resolveCodexCredential|CODEX_AUTH_JSON|codex-core|credentials/codex"
apps/api/src/router --include="*.ts"` returning zero files. The user's stored
subscription credential (and its refresh logic in
`apps/api/src/llm-gateway/credentials/codex.ts:96-122`, `resolveCodexCredential`) is
part of the modern `@kortix/llm-gateway` stack, which this Codex ACP launch path never
calls into.

### 5. The request is billed to the user (real DB deduction)

Same `handleKortixProxy`, lines 128-137: `service.isLlm === true` (true for `openai`,
`proxy-services.ts:223`) → `reserveEstimatedLlmCredits(accountId, body, KORTIX_MARKUP, actor)`
(`KORTIX_MARKUP = 1.2`, `apps/api/src/config.ts:1139`) reserves credits pre-flight
(`helpers.ts:245-312`, backed by `deductLLMCredits` at
`apps/api/src/router/services/billing.ts:89-125`, which calls `deductCreditsDb` — a real
account-balance write, gated only by `KORTIX_BILLING_INTERNAL_ENABLED`, on in prod/staging
per `apps/api/.env.prod`/`.env.staging`).

After the upstream call, `billLlmKortixProxy` (`handlers.ts:185-274`) parses real
usage and calls `settleLlmReservation` (`helpers.ts:379-445`) to true-up the
reservation to actual tokens — another real deduction/refund against the user's wallet.

**Net effect confirmed**: Kortix pays OpenAI/OpenRouter with its own key
(`getKortixApiKey()`), **and** the user's Kortix credit balance is debited
(`deductCreditsDb`) for the same request — the connected Codex subscription is
completely bypassed and provides the user zero benefit while they're billed as if they
had no subscription.

### Caveat — a worse variant is conditionally possible, not proven

`calculateCost` returns `$0` when `getModel(modelId)` can't find pricing
(`apps/api/src/router/config/models.ts:43-77`: unknown model → `inputPer1M: 0,
outputPer1M: 0`), and both `deductLLMCredits` (`billing.ts:97`) and
`reserveEstimatedLlmCredits`/`settleLlmReservation` skip deduction when
`calculatedCost <= 0`. Whether the real Codex model id (e.g. whatever `codex-acp`
actually reports on the `/responses` payload — `CODEX_CONFIG` defaults to
`openai/gpt-5.4`, `harness-registry.ts:402`) resolves in the live models.dev pricing
table was **not verified empirically** (no live Codex session available in this
worktree). If it doesn't resolve, the failure mode is strictly worse: Kortix pays
OpenAI/OpenRouter for real tokens and the user is billed **nothing** — pure loss. I did
not confirm or rule this out; flagging as open.

## Item 4 — Claude subscription path: no equivalent hazard, verified structurally different

`harness-registry.ts:495-501`: for `claude_subscription`, `CLAUDE_CODE_OAUTH_TOKEN`
survives `isolateHarnessAuthEnv` and is the *first* condition checked in the claude
branch, so it takes the **direct** path — the OAuth token is handed straight to the
`claude-agent-acp` adapter as an env var and Anthropic is called directly. It never
constructs a `DEFAULT_AUTH_REQUEST` pointing at `${apiUrl}/router`, so
`apps/api/src/router`'s Mode-1 Kortix-key-injection/billing code is never invoked for
this credential. There is no double-charge and no silent Kortix-key substitution for
Claude subscriptions, because the two paths never merge — the "same defect" cannot
occur here by construction. (This also means Kortix currently has no server-side
metering visibility into Claude-subscription token usage, but that's a different,
non-billing-leak property and was already known/expected.)

## Blast radius: branch-only, does not affect production today

- `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts` (the file containing
  the vulnerable codex routing) **does not exist on `origin/main`**:
  `git cat-file -e origin/main:apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`
  → `fatal: ... exists on disk, but not in 'origin/main'`. In fact the whole
  `apps/kortix-sandbox-agent-server/src/acp/` directory is absent from `origin/main`.
- `apps/api/src/router/config/proxy-services.ts`'s `openai` service *does* exist on
  main, but main's version is `getKortixApiKey: () => config.OPENAI_API_KEY` with no
  `kortixTargetBaseUrl`/OpenRouter fallback and no "Managed Codex" comment — the
  dual-mode Codex-capable version is also new to this branch
  (`git diff origin/main -- apps/api/src/router/config/proxy-services.ts` shows the
  whole block as an addition).
- `git log --oneline origin/main -- apps/kortix-sandbox-agent-server/src/acp/` shows
  main's most recent history for that path is `9eaefa14f Revert "Merge pull request
  #4495 from kortix-ai/acp-harness-runtime"` — the entire ACP harness runtime feature
  was merged once and then reverted from main. `HEAD` (this branch) is 190 commits
  ahead of the merge-base with main and is a from-scratch rebuild
  (`acp-harness-runtime-v2`), not yet merged, per PR #4510 and existing project memory
  ("merging PR into main FORBIDDEN without explicit go").
- **Conclusion**: production (`origin/main`) has no Codex ACP harness at all right now
  — this bug cannot fire in prod today. It would first become live if/when PR #4510
  merges to main and ships, at which point it is a real, active billing leak for any
  account that connects a Codex/ChatGPT subscription and runs a session on the Codex
  harness.

## What's empirical vs. static

- **Empirical (live stack)**: the `/v1/router` mount is live at
  `http://localhost:24508`; a `kortix_sb_`-prefixed bearer against
  `/v1/router/openai/responses` is recognized by `isKortixToken` and routed into the
  Mode-1 validate-or-reject branch exactly as read in `helpers.ts` — confirms the code
  path is real and reachable, not dead/unreachable code.
- **Static (code trace only, high confidence)**: everything else — the sandbox launch
  env construction, the absence of any `CODEX_AUTH_JSON` read in `apps/api/src/router`,
  the `getKortixApiKey()` substitution, and the `deductCreditsDb` billing call. I did
  not have a real Codex/ChatGPT OAuth credential to run a full end-to-end session and
  observe an actual outbound `Authorization` header hit OpenAI, or watch a real
  `account_credits`/billing-transactions row change. The Postgres port for this
  worktree's Supabase instance (expected `54322`) refused connections when queried
  read-only, so I could not additionally cross-check the local `project_secrets` table
  for a live `CODEX_AUTH_JSON` row.
- **Not determined**: whether the pricing-table lookup for the actual Codex model id
  hits or misses in the live models.dev catalog (the Caveat above) — this decides
  whether the leak is "double-billed" (confirmed structurally) or additionally "Kortix
  pays with zero user billing" in some fraction of requests.

## Minimal fix (recommendation only — not applied)

In `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`, the `codex` branch
of `resolveAcpHarnessLaunchEnv` needs a `codex_subscription`-specific case, mirroring
what already exists for direct keys: route through a Codex-aware endpoint (or extend
`/router/openai` — or better, the modern `@kortix/llm-gateway`, which already has
working `resolveCodexCredential`/refresh logic in
`apps/api/src/llm-gateway/credentials/codex.ts`) so the outbound call to OpenAI carries
the user's `CODEX_AUTH_JSON` access token, and the request is either billed at $0 Kortix
credits (subscription-covered) or not billed at all — not both charged to the user and
paid for out of Kortix's own key. The `apps/api/src/router` `openai` proxy service's
Mode-1 fallback (`getKortixApiKey`) should not be the default destination for a
`codex_subscription`-authenticated session at all.
