# Gateway as universal transport — architecture plan

Status: proposed, for owner decision on the open questions in §7
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510 (four ACP harnesses: Claude
Code, Codex, OpenCode, Pi)
Author: Claude (planning agent), for Marko

Decision this plan is built for (final, not relitigated here): the LLM gateway
becomes the single central transport for all four ACP harnesses. Every claim
below is grounded at `file:line` and re-verified against the current worktree
state (`HEAD f0b23ddd4`), not assumed from the three prerequisite docs. Where
this plan **corrects** something those docs asserted, the correction is called
out explicitly, because two of the corrections change the shape of the work.

Prerequisite reading (not restated in full here): `2026-07-21-llm-credential-
and-model-management.md` (current-state map, Part 5 especially),
`2026-07-21-codex-billing-leak-verification.md` (the confirmed bug this plan
must make structurally impossible), `2026-07-14-provider-auth-model-
management.md` (the earlier connection-model spec).

---

## 0. Three corrections to the stated priors — read this first

These change what "close the gap" actually costs.

**Correction A — the Anthropic-Messages ingress is already mounted in-API, not
standalone-pod-only.** `2026-07-21-llm-credential-and-model-management.md`
§5.4 states Claude's wire shape is only ingestible on the standalone gateway
pod. That was true as recently as `dad64456c` but is no longer true at HEAD:
`apps/api/src/llm-gateway/wire.ts:387-410` (`mountLlmGateway`) registers
`llm.post('/messages', messages)` and `llm.post('/v1/messages', messages)`
inside the **in-process** gateway, alongside `/chat/completions`. Confirmed by
reading the mount function directly, not inferred. **The Claude-shape
ingestion gap is smaller than believed** — both deployment modes (in-API and
standalone pod) already speak Anthropic Messages. What's still missing for
Claude is not ingress format; it's credential wiring (§2, Claude row) and, if
kept, a custody decision (§4).

**Correction B — Pi does not actually use the modern gateway today, contrary
to the baseline doc's claim.** §1.2/5.3 of the credential doc state "This is
what OpenCode/Pi's `managed_gateway` connection kind actually calls
(`KORTIX_LLM_BASE_URL`/`KORTIX_LLM_API_KEY`...)". Verified false for Pi.
`KORTIX_LLM_BASE_URL`/`KORTIX_LLM_API_KEY` are read in exactly one place in
the whole tree: `apps/kortix-sandbox-agent-server/src/acp/opencode-
gateway.ts:212-213`, consumed only by `buildOpencodeKortixProvider`, called
only from the `id === 'opencode'` branch of `resolveAcpHarnessLaunchEnv`
(`harness-registry.ts:284-347`). Pi's own branch
(`harness-registry.ts:415-492`) never references `KORTIX_LLM_BASE_URL` at
all. Pi's fallback path (taken whenever there's no custom endpoint and no
`OPENAI_API_KEY`/`CODEX_API_KEY`, lines 467-491) instead builds
`KORTIX_PI_MODELS_JSON` pointing at `${apiUrl}/router/openai` — **the OLD
router (stack B)**, with `api: 'openai-responses'`. So: **only OpenCode is
genuinely on the modern gateway (stack A) today. Pi is in the same bucket as
Codex** — routed through stack B, over the wire shape stack A cannot ingest.
This means the "widen who talks to the modern gateway" work is a 3-harness
problem (Claude, Codex, Pi), not a 2-harness problem (Claude, Codex) as the
prior framing implied.

**Correction C — a related, unverified but concrete finding: Claude Code's own
"no explicit credential" fallback may already be pointed at a route that
doesn't exist.** `harness-registry.ts:511-521`, the final Claude branch
(reached when there is no API key/OAuth token and no custom endpoint, but
`apiUrl`/`token` are set) sets `ANTHROPIC_BASE_URL: '${apiUrl}/router'`. The
Claude Code CLI appends `/v1/messages` to whatever base URL it's given. The
old router (stack B) has no route matching `/router/v1/messages` —
`router/routes/llm.ts` only registers `/chat/completions`, and
`router/routes/proxy/routes.ts` only registers `/anthropic/*` (i.e. the
matching path would need to be `${apiUrl}/router/anthropic`, one path segment
different from what's actually set). **Not independently confirmed this
branch is ever live-reached** — Claude's `authKinds` today are only
`claude_subscription`/`anthropic_api_key`/`native_config` (no
`managed_gateway`, per the 2026-07-15 founder decision), so
`composer-capabilities.ts`'s connection gate may make this branch
unreachable in the current product. Flagging because if it *is* reachable
(e.g. a stale/legacy code path, or a future re-enable of Claude+gateway), it
is a live 404, not a working fallback — worth a five-minute check by whoever
touches this file next, not fixed here per the read-only scope.

**Correction D (the load-bearing one for §2) — the exact provenance mechanism
the owner asked for already exists in stack A's domain model, unused by any
ACP harness.** `packages/llm-gateway/src/domain/descriptor.ts:26` and
`principal.ts:32`: every `UpstreamDescriptor` carries a
`billingMode: 'credits' | 'platform-fee' | 'none'`. This is wired through the
whole pipeline — `handler.ts:877` (`markup = billingMode === 'none' ? 0 :
descriptor.markup`), `hooks.ts:244` (`billingMode === 'none'` skips the
credit-recording call entirely), `trace.ts`/`usage.ts` (every trace/usage
record carries it). Three call sites already assign it correctly:
- `descriptors.ts:92,125` (managed Bedrock/OpenRouter) → `'credits'`.
- `resolve-candidates.ts:174-176` (BYOK provider key) → `'platform-fee'`
  (10% markup) or `'none'` on free tier.
- **`descriptors.ts:150-168` (`codexDescriptor`) → `'none'`, `markup: 0`,
  `apiKey: credential.access`** (the real, refreshed OAuth access token from
  `resolveCodexCredential`, `resolve-candidates.ts:97-129`), `baseUrl:
  CHATGPT_CODEX_BASE_URL` (the real ChatGPT/Codex backend, not
  Kortix's own OpenAI/OpenRouter key). **This is precisely the correct,
  non-substitutable behavior the owner is asking for — for Codex — and it is
  reachable today** via `POST /v1/llm/chat/completions` (or the standalone
  pod's alias) with `model: "codex/<id>"`. It is simply never called by the
  Codex ACP harness, which instead hits stack B (`${apiUrl}/router/openai`,
  `harness-registry.ts:398-413`) — the exact confirmed leak. **No equivalent
  `claudeDescriptor`/`resolveClaudeCredential` exists anywhere in the tree**
  (grepped for `CLAUDE_CODE_OAUTH_TOKEN`/`claude_subscription` across
  `apps/api/src/llm-gateway` — zero hits) — Claude subscription attribution
  in stack A is not started at all.

**Net effect of these four corrections on the plan**: the hard, novel part of
"subscriptions are an auth mode, not a model source" is *already solved in
code* for Codex, sitting one hop away from being used correctly. The real
work is (1) building the missing ingress translation so Codex's and Pi's
native wire shape can reach stack A at all, (2) building Claude's equivalent
descriptor/credential path from scratch, (3) re-pointing the ACP launch env
for all three harnesses at stack A instead of stack B/direct, and (4)
deciding what happens to stack B. None of it requires inventing a new
provenance concept — `billingMode` already is one, just needs a companion
concept one level up (see §2.3) for the "attribute to this specific user's
subscription, not just don't-bill" half, which `billingMode: 'none'` alone
doesn't fully capture (it says "free," not "whose").

---

## 1. Per-harness transport matrix

| Harness | Wire shape it emits (verified) | Auth modes it supports | Pointed at gateway today? | What must be built to make it so |
|---|---|---|---|---|
| **OpenCode** | OpenAI chat-completions, via `@ai-sdk/openai-compatible` (`opencode-gateway.ts:222-227`, `npm: '@ai-sdk/openai-compatible'`) | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` (`harnesses.ts`) | **Yes, already**, for `managed_gateway` — `KORTIX_LLM_BASE_URL`/`KORTIX_LLM_API_KEY` → stack A `/v1/llm/chat/completions` (`opencode-gateway.ts:212-227`) | Nothing for the gateway-transport question itself. Its BYOK connection kinds (`anthropic_api_key`/`openai_api_key`) still go **direct**, bypassing the gateway entirely (`harness-registry.ts` sets provider config pointing at the raw key/native endpoint, not at `KORTIX_LLM_BASE_URL`) — routing those through the gateway too is a policy choice (§4), not a technical gap: the ingress already accepts chat-completions shape. |
| **Pi** | **OpenAI Responses shape** — every branch of the Pi config sets `api: 'openai-responses'` (`harness-registry.ts:424,450,474`), including its own "kortix" fallback | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` (per `harnesses.ts`) — but **no code path was found that actually serves `anthropic_api_key` for Pi**; every branch in `resolveAcpHarnessLaunchEnv`'s `id === 'pi'` case is OpenAI-Responses-shaped only (see Correction B and the open question in §7) | **No** (Correction B) — its default/managed path hits stack B's dumb passthrough proxy (`${apiUrl}/router/openai`), not stack A | A Responses-shaped ingress on stack A (does not exist anywhere — grepped, zero `/v1/responses`-style route; `openai-responses` in `route-kind.ts`/`ai-sdk/index.ts` is an **egress** transport choice only, never an ingress format). Same missing piece as Codex — see §1 Codex row, this is shared work, not double work. Separately: the claimed `anthropic_api_key` support for Pi needs a real code path or the compatibility table needs correcting — unverified either way, flagged in §7. |
| **Claude Code** | Anthropic Messages API, native to the `claude-agent-acp` adapter and to any process reading `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` | `claude_subscription`, `anthropic_api_key`, `native_config` (no `managed_gateway` — 2026-07-15 founder decision) | **No** for any mode. Direct API key/subscription: forwarded straight to the adapter as env (`harness-registry.ts:493-501`), Anthropic called directly — no gateway involvement, by design. | Ingress already exists (Correction A: `/v1/llm/messages` mounted in-API). What's missing: (a) a `claudeDescriptor`/`resolveClaudeCredential` pair mirroring Codex's (does not exist, Correction D), (b) a custody decision (§4) — today the OAuth bearer goes straight into the adapter's env; centralizing means either the gateway holds/attaches the token server-side (custody change, see below) or the token still flows to the adapter but the adapter is pointed at the gateway with the token forwarded through (weaker: gateway sees the raw subscription token pass through it, same trust boundary as today plus a hop). |
| **Codex** | **OpenAI Responses shape** — `codex-acp`'s native wire format; confirmed by `codexDescriptor`'s own header set (`originator: 'codex_cli_rs'`, `'OpenAI-Beta': 'responses=experimental'`, `descriptors.ts:150-168`) and by the fact `kind: 'openai-responses'` is what the *existing, unused* `codexDescriptor` already declares as its egress shape | `codex_subscription`, `openai_api_key`, `native_config` (no `managed_gateway`) | **No.** Direct API key: native, no gateway. Subscription: **CONFIRMED LEAK** — routes through stack B, Kortix's own key pays upstream, user is billed Kortix credits, subscription unused (`2026-07-21-codex-billing-leak-verification.md`, reconfirmed by reading the same files in this pass) | Same missing Responses-shaped ingress as Pi (shared work). The billing/attribution machinery for the "correct" outcome (`billingMode:'none'`, real credential, real upstream) **already exists** (`codexDescriptor`, Correction D) and just needs the ingress in front of it plus the launch-env re-point (§5). |

**Scope estimate for the shared blocker (Responses-shaped ingress)**: this is a
third ingress translator following an established pattern — chat-completions
(native), Anthropic Messages (`ingress/anthropic-messages.ts`, ~edge-only
translation feeding the same internal pipeline). A Responses-shaped ingress is
the same shape of work: parse `{input, model, tools, ...}` into the existing
canonical internal request, translate the response/SSE back to Responses
event shapes on the way out. Non-trivial but bounded — git history contains a
now-deleted native `openai-responses` transport
(`transports/openai-responses/request.ts`'s `chatToResponses`, removed in
`ba6b23642`'s AI-SDK consolidation) that solved the **egress** half of the
same shape-translation problem; the ingress direction is new work but not
unprecedented in this codebase. Estimate: similar order of magnitude to the
Anthropic-Messages ingress that already shipped — call it one focused
workstream, not a quarter, but real enough that it should be its own tracked
piece of work, not a subtask of "point Codex at the gateway."

---

## 2. Billing and attribution model

### 2.1 The mechanism to build on

`BillingMode` (`packages/llm-gateway/src/domain/principal.ts:32`) is the
existing provenance primitive:

```ts
export type BillingMode = 'credits' | 'platform-fee' | 'none';
```

It already flows end-to-end: assigned once on the `UpstreamDescriptor` at
resolution time, carried through failover (`failover.ts:225,282`), read at
markup-computation time (`handler.ts:877`), and recorded on every trace/usage
event (`trace.ts:15`, `usage.ts:26`) — including a hard skip of the
credit-recording RPC when `billingMode === 'none'` (`hooks.ts:244`). This is
the load-bearing fact for the whole "make substitution structurally
impossible" requirement: **the decision of what to bill is made once, at
resolution time, by whichever function builds the descriptor — never
re-derived downstream, never inferable from "well it hit the OpenAI upstream
so bill it like OpenAI."** A caller cannot accidentally bill a subscription
call as credits without a code change to the descriptor-building function
itself, because nothing downstream re-decides it.

### 2.2 The table

| Credential provenance | Traffic kind | `billingMode` | Who pays | What's metered | What's logged |
|---|---|---|---|---|---|
| Kortix-managed (Bedrock/OpenRouter, platform keys) | Managed model, any harness | `credits` | Kortix credit balance, at markup (`descriptors.ts:92,125`) | Full token usage, converted to credits | Full trace + usage row, `kortix.billing_mode: 'credits'` |
| User BYOK provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, custom endpoint) | Direct-to-provider or gateway-routed | `platform-fee` (10%, `PLATFORM_FEE_MARKUP`) or `none` on free tier | The user's own provider bill; Kortix takes a 10% platform fee on top when internal billing is on | Token usage recorded for the fee calculation and for the user's own observability | Full trace + usage row, `billing_mode: 'platform-fee'` |
| User subscription (Codex/ChatGPT OAuth bundle, Claude Pro/Max OAuth token) | Subscription-covered, any harness that credential authenticates | **`none`**, `markup: 0` | Nobody — pre-paid by the user's own subscription, outside Kortix's billing surface entirely | Token usage still recorded (trace/usage rows are written; only the *credit-deduction* call is skipped, `hooks.ts:244`) — this is attribution, not silence | Full trace + usage row, `billing_mode: 'none'`, `apiKey`/credential never logged (only redacted diagnostics per the 07-14 spec §3.3) |

### 2.3 The gap `billingMode` alone does not close

`billingMode: 'none'` answers "should this be billed" but not "which specific
user's subscription paid for this, and can I tell my customer-success/finance
team that." Today's `codexDescriptor` correctly sets `billingMode:'none'`
**and** carries the real credential forward (so the *upstream* call is
correctly attributed — OpenAI/Anthropic's own billing sees the real
subscription), but nothing in the gateway's own trace schema was found to
carry a distinct "this was subscription-attributed to user X" tag separate
from "this was free." Recommendation: add a `provenance` field alongside
`billingMode` on the trace/usage record —
`'kortix-managed' | 'byok' | 'subscription'` — so subscription traffic is
queryable/reportable as its own category (usage dashboards, abuse detection,
"how much subscription-covered traffic flows through us") without conflating
it with "free tier with nothing to bill." Small, additive schema change; not
a blocker to shipping the rest of this plan, but should land in the same
phase as the Codex/Pi/Claude descriptor work (§5 step 3) rather than after,
since retrofitting historical trace rows is not possible.

### 2.4 The structural-impossibility guarantee, stated precisely

The mechanism that makes "silently degrade to Kortix's managed key" (the
confirmed Codex bug) impossible under this design is: **the function that
resolves a credential into an `UpstreamDescriptor` is the only place
`billingMode` is set, and it is set from the credential's own kind, not
inferred from the request.** `resolveCandidates` (`resolve-candidates.ts`)
already enforces this shape — a `codex/*` model always goes through
`resolveCodexCredential` → `codexDescriptor`, which can only ever produce
`billingMode:'none'` + the real access token, or throw
(`CodexRefreshError`/`GatewayResolutionError`) if the credential is missing
or unrefreshable. **There is no code path today where a `codex/*` request
successfully resolves to a Kortix-managed descriptor** — the leak exists
*only* because the Codex ACP harness never calls this resolver at all (it
calls stack B instead, which has no such per-credential-kind branching, just
three generic auth "modes" keyed off who owns the bearer token). Consolidating
Codex (and Pi, and a to-be-built Claude path) onto stack A's resolver is
therefore not just "the fix" — it is the only design where the substitution
bug becomes a type of error (missing/throwing resolver) rather than a type of
silent success (stack B's Mode 1 always succeeds by falling back to a Kortix
key). This is the concrete answer to the task's "make it structurally
impossible" requirement — not a new check to add, but a topology property to
get right: **exactly one code path resolves a credential to a bill-mode, and
subscription credentials feed a resolver that cannot silently substitute
because it has no Kortix-key branch in the first place.**

---

## 3. Router consolidation plan

`apps/api/src/router` (stack B) is not a monolith to delete — it serves two
genuinely different concerns:

1. **LLM-shaped traffic**: `router/routes/llm.ts` (`/chat/completions`,
   proxied to OpenRouter, its own `billing.ts`/`member-spend.ts`) and the
   `anthropic`/`openai`/`xai`/`gemini`/`groq` lanes of
   `router/config/proxy-services.ts`'s generic passthrough proxy (12 services
   total, `proxy-services.ts:61-253`). **This is the part in scope for
   consolidation.**
2. **Non-LLM tool-API proxying**: `tavily`, `serper`, `apify`, `firecrawl`,
   `replicate`, `context7` — search, scraping, image-gen, and doc-lookup
   proxies with the same three-auth-mode/billing shape but nothing to do with
   model transport. **Out of scope. These must keep a home regardless of
   the gateway decision** — deleting `apps/api/src/router` wholesale would
   take these down too.

### 3.1 Recommendation: absorb the LLM lanes into stack A, keep the module for tool proxying

- Move `codex`/`openai` (already has a stack-A path)/`anthropic` (needs the
  new Claude descriptor)/`xai`/`gemini`/`groq` LLM-proxy traffic onto stack A
  by building the missing per-provider descriptors and ingress translators
  (§1, §5).
- `router/routes/llm.ts`'s `/chat/completions` (OpenRouter proxy, its own
  billing) becomes redundant with stack A's own OpenRouter-backed managed
  descriptors (`descriptors.ts` `openRouterManagedDescriptor`) — retire it
  once nothing calls it (verify call sites first: this is a documented
  general-purpose OpenAI-compatible proxy, not obviously ACP-only; **grep for
  every caller before retiring**, not done in this read-only pass).
- Keep `apps/api/src/router` alive, renamed in spirit (not necessarily in
  path — a path rename is a breaking change to every existing tool-proxy
  caller and not obviously worth it) as the **tool-API proxy**, scoped to
  `tavily`/`serper`/`apify`/`firecrawl`/`replicate`/`context7` plus whatever
  of the LLM lanes aren't yet migrated during the transition window.
- Its independent billing implementation (`router/services/billing.ts`,
  `member-spend.ts`) stays — it's the correct, isolated billing surface for
  tool-API spend, which is a different cost model (flat per-call, not
  per-token) from LLM spend. Do not try to unify tool-API billing into the
  gateway's usage/credits pipeline as part of this work; that's a separate,
  unrelated consolidation with its own scope.

### 3.2 Sequencing so nothing loses billing coverage mid-migration

The dangerous order is: cut a harness over to stack A before stack A can
serve its shape, or delete a stack-B lane before its stack-A replacement is
live and tested. Concretely:

1. Ship the Responses-shaped ingress on stack A (§1) — **additive, nothing
   depends on it yet, zero risk to existing traffic.**
2. Ship `claudeDescriptor`/`resolveClaudeCredential`, mirroring
   `codexDescriptor` — **additive**, reachable only via an explicit
   `model: "claude-subscription/*"`-style request nothing calls yet.
3. Flip Codex ACP harness launch env from `${apiUrl}/router/openai` to the
   new stack-A Responses ingress, **behind a flag**, verified against a real
   Codex/ChatGPT subscription in a real sandbox before the flag defaults on
   (this is exactly the class of bug that needs a live trace, not a code
   read, to close out — the 07-21 verification doc's own "not determined"
   list should be resolved by this step's testing, not skipped).
4. Same for Pi.
5. Same for Claude, plus the custody decision (§4) resolved first — this one
   is not purely additive if the custody model changes.
6. Only after all three are cut over and stable: retire the now-unused
   `${apiUrl}/router/openai`/`/router/anthropic` lanes from stack B's LLM
   surface. Do not retire before confirming (via request logs / a deploy
   window with both paths live) that nothing else still points at them —
   the `native_config`/custom-endpoint branches in `harness-registry.ts`
   never touch stack B at all, so this is scoped to exactly the
   `codex_subscription`/Pi-default/(new) Claude-gateway branches.
7. Tool-API lanes (`tavily`, etc.) are never touched by any of the above.

### 3.3 What must NOT be deleted, and why

- `router/routes/proxy/**`'s multi-service passthrough machinery
  (`handlers.ts`, `helpers.ts`, three-auth-mode logic) — still the home for
  6 non-LLM services. Full deletion (as opposed to narrowing its LLM
  surface) is out of scope and would be a regression.
- `router/services/billing.ts`/`member-spend.ts` — still the billing engine
  for whatever stays on stack B.
- Nothing under `apps/api/src/router/**` should be touched by whoever
  implements this plan without re-reading this section — per the task's own
  constraint list that path is explicitly off-limits to this planning pass,
  and per §3.1 it should stay largely alive rather than deleted regardless.

---

## 4. What is lost by centralizing — stated honestly

**Latency.** Every harness call gains a hop it doesn't have today for BYOK/
direct traffic: sandbox → Kortix API/gateway → provider, instead of
sandbox → provider. For Claude/Codex specifically, this also adds the
ingress-translation cost (Responses↔canonical↔Responses, or
Anthropic-Messages↔canonical↔Anthropic-Messages) on every turn, not just
per-session setup — a real, per-token-stream cost, not a one-time
connection cost. Not measured in this pass (no live A/B numbers found in the
capability-matrix doc referenced by the baseline read); should be benchmarked
before flipping any default, not assumed acceptable.

**New single point of failure.** Today, a BYOK Claude Code session has one
dependency: Anthropic's own API being up. Under this plan it has two:
Anthropic's API **and** the Kortix gateway (in-process API or standalone pod)
being up, reachable, and not rate-limited/budget-capped by an unrelated
project's traffic on the same shared infrastructure. The gateway's own
`/health` endpoint (`apps/llm-gateway/src/server.ts:115-166`) already models
circuit-breaker/error-rate degradation as a first-class concept, which is
good — but it does not remove the fact that a Kortix outage now takes down
*every* harness's *every* traffic class, including BYOK sessions that today
survive a Kortix outage untouched (they only need the sandbox and the
provider, not Kortix's control plane, once the session is running — actually
even that needs re-verification: does an already-running BYOK Claude Code
session need Kortix API reachability at all today, mid-turn? Per
`harness-registry.ts:493-501` the credential is baked into the adapter's env
at launch time and Anthropic is called directly — **a running BYOK session
should currently survive a Kortix API outage**; centralizing removes that
resilience property for the harnesses moved onto the gateway).

**Gateway becomes a hard dependency for BYOK users who currently don't need
it.** Concretely: `LLM_GATEWAY_ENABLED` defaults to `false`
(`config.ts:326`) and is explicitly "off by default" — a self-host operator
running Claude Code with their own Anthropic key today needs zero gateway
component running at all. Under a fully gateway-centric design, that
operator must run the gateway (in-process is free — it's part of the API
process — but it is no longer optional) just to get their own BYOK key to
their own provider. This is a real new operational requirement, not free.

**Self-host implications, concretely.** `KORTIX_MANAGED_PROVIDER_ENABLED`
already models "self-host still runs the gateway for its own BYOK routing,
it just must never see or route to Kortix's shared credentials"
(`config.ts:327-339`) — so the *codebase* already anticipates a
gateway-mandatory self-host posture for OpenCode. Extending that posture to
Claude/Codex/Pi is consistent with existing self-host design intent, but it
does mean self-host deployments that today run zero LLM-gateway
infrastructure (pure direct-to-provider, `LLM_GATEWAY_ENABLED=false`) would
need to flip that flag on to run any harness at all — a first-run/setup
change for self-host operators, not just a cloud-side migration.

**Loss of "dumb passthrough" resilience for the currently-unsupported
providers.** Stack B's proxy (`proxy-services.ts`) is a genuinely
protocol-agnostic reverse proxy with billing bolted on — it works for
`xai`/`gemini`/`groq` today with zero per-provider wire-shape work because it
never parses the body. Stack A's ingress model requires understanding each
wire shape to attribute billing correctly per §2. This is the right trade for
correctness (§2.4's structural-impossibility guarantee is not achievable with
a dumb proxy — that's precisely how the Codex leak happened), but it is
slower to extend to a new provider than stack B was, and should be named as a
real velocity cost, not hand-waved.

**Not one-sided: what's gained, briefly, for balance.** Central real cost
tracking (today BYOK spend is invisible to Kortix — the "loss" framing above
is symmetric with the memory-noted fact that BYOK-direct means zero Kortix
observability of that spend either), one place to implement fallback/
failover across the whole fleet of harnesses instead of three independently
half-built ones (stack A's failover/circuit-breaker is real and tested; stack
B has none; direct has none by definition), and — the actual point of this
whole exercise — the only design in which the Codex-class leak becomes
structurally hard to reintroduce (§2.4).

---

## 5. Ordered migration sequence

Each step states whether it's independently shippable (i.e., safe to merge
and deploy alone, dark or not) and flags the risky ones.

1. **Build the Responses-shaped ingress on stack A.** Independently
   shippable — purely additive, no existing caller depends on it yet, mirrors
   the `anthropic-messages.ts` pattern. *Not risky in isolation*; risk is
   entirely in correctness of the translation (streaming event shapes
   especially — Responses' SSE event vocabulary differs from chat-completions'
   and from Anthropic's, a third distinct SSE grammar to get right).
2. **Build `claudeDescriptor` + `resolveClaudeCredential`,** mirroring
   `codexDescriptor`/`resolveCodexCredential` exactly (same store, same
   shared/personal precedence, `billingMode:'none'`). Independently
   shippable — additive, unreachable until something requests
   `claude-subscription/*`-shaped models.
3. **Add the `provenance` field to the trace/usage schema** (§2.3).
   Independently shippable, should land before step 4 starts producing real
   traffic so no historical gap exists.
4. **Flag-gated cutover: Codex ACP harness → stack A.** *Risky* — this is the
   step that actually closes the confirmed leak, and per the verification
   doc's own "not determined" list, needs a **live Codex/ChatGPT OAuth
   session in a real sandbox** to confirm the pricing-table lookup for the
   real Codex model id resolves (the doc's "Caveat": an unresolved price
   silently zeroes the credit deduction — a much smaller problem once
   `billingMode:'none'` is doing the work intentionally, but worth
   re-confirming the intended-zero and the accidental-zero produce
   indistinguishable trace rows unless the model-id → pricing lookup is
   fixed as part of this step too). Gate on a flag; do not flip the default
   without this live confirmation.
5. **Flag-gated cutover: Pi → stack A**, same shape as step 4, lower risk
   (no subscription-substitution hazard for Pi per §1, since Pi has no
   subscription auth kind — this is a pure protocol/topology migration, not
   a billing-correctness fix). Can happen in parallel with step 4, not
   sequentially dependent on it beyond sharing the same new ingress.
6. **Resolve the Claude custody question (§4/§7)** — a product decision, not
   an engineering step, but it blocks step 7 by definition (the code shape
   differs depending on the answer).
7. **Flag-gated cutover: Claude Code → stack A**, shaped by step 6's answer.
   *Risky* in the same class as step 4 — new code path, needs live
   verification against a real Claude Pro/Max subscription before defaulting
   on.
8. **Retire the now-dead stack-B LLM lanes** (§3.2 step 6) — only after 4/5/7
   are stable in production for a real observation window (suggest: at least
   one full billing cycle, so any subscription-attribution discrepancy shows
   up in reconciliation before the old, known-correct-for-BYOK path is gone).
9. **Decide and execute the BYOK-through-gateway question** (§4's "should
   BYOK traffic move onto the gateway too, for observability") — explicitly
   separable from all of the above; nothing in steps 1-8 requires resolving
   it, and the honest-cost section (§4) argues it should be a deliberate,
   separately-justified call, not a side effect of closing the subscription
   leak.

Steps 1, 2, 3, 5 can start immediately and in parallel. Step 4 depends on 1+3.
Step 7 depends on 1 (if Claude keeps its ingress-only need) or 2+3+6. Step 8
depends on 4, 5, 7 all being stable. Step 9 is independent of the whole
sequence and should not block it.

---

## 6. Deliverable cross-reference

For quick navigation: §1 = per-harness matrix, §2 = billing/attribution
table, §3 = router consolidation, §4 = honest costs, §5 = migration sequence,
§7 below = open questions.

---

## 7. Explicit open questions for the owner

1. **Does Pi actually support `anthropic_api_key` today, or is the
   compatibility table (`harnesses.ts`) aspirational?** No code path was
   found in `resolveAcpHarnessLaunchEnv`'s `id === 'pi'` branch that serves
   an Anthropic-shaped connection — every branch is OpenAI-Responses-shaped.
   Either there's a code path this pass missed, or Pi's real capability is
   narrower than the declared table. Needs a five-minute live check (connect
   an Anthropic key, select Pi, start a session, see what actually launches)
   by someone who owns that surface — flagged as unverified, not asserted.

2. **What should Claude's custody model become?** Three options, not
   resolved by this plan:
   - (a) Keep direct: Claude subscription stays fully outside the gateway,
     forwarded straight to the adapter as today. Simplest, but means Claude
     is the one harness never centrally metered even after this project
     ships, contradicting "one place that knows all traffic."
   - (b) Gateway-mediated, token still forwarded through: the adapter is
     pointed at the gateway's `/v1/llm/messages`, with the OAuth bearer
     forwarded as the `Authorization` header (same trust exposure as today,
     the token still leaves Kortix's server into a process the sandbox
     controls — just now that process is the gateway's HTTP handler instead
     of Anthropic's, no new custody but no new protection either).
   - (c) Gateway-held: the token never reaches the sandbox at all, the
     adapter authenticates to the gateway with a Kortix session token (same
     shape as Codex today), and the gateway attaches the real Claude OAuth
     credential server-side via the new `claudeDescriptor`. This is the only
     option that closes the "adapter process holds a real Anthropic
     subscription token" exposure, but it is also the one that most
     resembles the exact shape that produced the Codex leak (server holds
     the credential, sandbox gets a proxy token) — meaning it inherits the
     same *structural* risk class unless built with the same
     `billingMode:'none'` discipline from day one (§2.4). This is a real
     ToS/security question (the earlier 07-21 doc flagged it as unresolved
     and unverified whether Anthropic's subscription terms permit anything
     but the official client holding the token) that this plan cannot answer
     — it needs an explicit legal/product call, not an engineering default.

3. **Does the "one place that knows all models, does fallback/routing"
   benefit apply to BYOK traffic, or only to subscription/managed?** §4's
   honest-cost section argues these are different questions with different
   answers — routing subscription traffic through the gateway is required to
   fix the leak; routing BYOK traffic through the gateway is a separate,
   optional choice trading BYOK users' current gateway-independence for
   Kortix-side observability/allowlisting of their own key's spend. The task
   framing ("single central transport for all four harnesses") reads as
   "yes, all traffic," but that should be said explicitly, not inferred,
   because it's the step with the largest blast radius on self-host and on
   BYOK users' current failure-independence from Kortix's own uptime.

4. **Is `router/routes/llm.ts`'s `/chat/completions` (OpenRouter proxy) still
   called by anything outside the ACP harnesses?** Not verified in this
   pass — a full caller grep is needed before retiring it (§3.1). If it's
   also the general-purpose "any authenticated caller can hit
   `/v1/router/chat/completions`" surface for non-ACP use cases (headless
   API consumers, internal tooling), retiring it is a breaking API change
   for those callers, not just an internal cleanup.

5. **What latency and availability budget is acceptable for the added hop?**
   No live numbers were available in this pass (would require running both
   paths side-by-side against a real provider). Recommend measuring p50/p99
   added latency and gateway-outage blast radius (how many concurrent
   sessions would a gateway incident affect once Claude/Codex/Pi are all
   behind it, versus today's zero for BYOK) before committing to a hard
   cutover date in step 8 of §5.

6. **Should the new `provenance` trace field (§2.3) be a broader identity than
   just billing-relevant?** i.e., should it also record *which* connection/
   credential record served the request (for the "used by Claude Code" /
   "used by Codex" UI surfaces the 07-14 spec already designed), or stay
   narrowly scoped to the credits/platform-fee/subscription split? Affects
   schema design in step 3 of §5 — worth deciding once, not twice.
