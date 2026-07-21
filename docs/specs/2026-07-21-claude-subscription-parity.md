# Claude subscription parity with Codex — feasibility and plan

Status: proposed, for owner decision on §2's policy question before any Tier C work
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510. Read-only investigation; no code
changed. Every claim below is grounded at `file:line`, re-read directly in this pass
(not copied from the prerequisite docs without verification), plus one primary-source
web fetch of Anthropic's own policy page.

Prerequisite reading (not restated in full): `2026-07-21-codex-billing-leak-
verification.md` (the confirmed bug this plan must not reintroduce),
`2026-07-21-llm-credential-and-model-management.md` (Part 5 especially — the store,
the three routing stacks, the `billingMode` mechanism), `2026-07-21-gateway-universal-
transport-plan.md` (the `claudeDescriptor`/ingress gap analysis, §7 open question 2).
This document narrows those three down to the single question the owner actually
asked: **can the Codex subscription mechanism just be applied to Claude?**

**Headline answer: no, not as a server-side relay — and the reason is not a technical
gap, it's Anthropic's own written policy, which this pass located and quotes verbatim
in §2.** That finding changes the shape of "the same system for Claude" from an
engineering question into a policy one, for a wider slice of the design than the task
briefing assumed. §3 lays out what's still unblocked regardless.

---

## 1. Verifying the asymmetry — corrected against the actual code

The task briefing's baseline is mostly right. Three corrections, all verified by
direct read in this pass:

### 1.1 Confirmed as stated

- **Codex has a real OAuth device-code flow**, stored encrypted as `CODEX_AUTH_JSON`,
  resolved/refreshed in-process by `resolveCodexCredential`
  (`apps/api/src/llm-gateway/credentials/codex.ts:96-122`).
- **`codexDescriptor`** (`apps/api/src/llm-gateway/resolution/descriptors.ts:150-168`)
  targets `CHATGPT_CODEX_BASE_URL` with `billingMode: 'none'`, `markup: 0`, and the
  real access token — the correct, non-substitutable shape.
- **A dedicated `/router/codex-subscription` route exists and fails closed.** Read in
  full: `apps/api/src/router/routes/proxy/codex-subscription.ts`. It only accepts a
  `kortix_pat_…` account token (`validateAccountToken`, line 59 — a `kortix_sb_…`
  sandbox token is rejected outright, so the generic Kortix-managed-key catch-all can
  never be reached from here by construction), resolves the caller's own
  `CODEX_AUTH_JSON` via the same `resolveCodexCredential` the modern gateway uses, and
  throws 401/502 rather than silently falling back on a missing/expired credential
  (lines 79-93). `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts:368-398`
  is the only launch path that points a session at it, and its own comment (lines
  387-397) states the fail-closed rationale explicitly: "refusing to fall back to the
  Kortix-managed gateway key for a subscription-authenticated Codex session." **This
  is a real fix, already landed on this branch** — it postdates and closes the leak
  documented in `2026-07-21-codex-billing-leak-verification.md`. That verification
  doc's own item 4 (lines 159-171) already independently confirmed Claude has no
  equivalent hazard — re-verified here, same conclusion, see 1.2.
- **No `claudeDescriptor`, no refresh path, no `billingMode` declaration for Claude.**
  Grepped `apps/api/src/llm-gateway` for `CLAUDE_CODE_OAUTH_TOKEN`/`claude_subscription`
  — zero hits outside `harness-registry.ts`. Confirmed.

### 1.2 Confirmed, with the exact mechanism spelled out

`apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts:540-548`:

```ts
if (id !== 'claude') return Object.keys(native).length ? native : undefined
if (authKind === 'native_config') return Object.keys(native).length ? native : undefined
if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
  const direct = { ...native, ...(runtimeModel ? { ANTHROPIC_MODEL: runtimeModel } : {}) }
  return Object.keys(direct).length ? direct : undefined
}
```

`CLAUDE_CODE_OAUTH_TOKEN` survives `isolateHarnessAuthEnv` for `claude_subscription`
(`AUTH_ENV_BY_KIND.claude_subscription = ['CLAUDE_CODE_OAUTH_TOKEN']`, line 36) and is
the *first* condition this branch checks — true, so it takes the **direct** path:
`native` (built earlier in the function) already contains the raw env, unmodified nothing is
stripped or redirected. `ANTHROPIC_BASE_URL` is never set, so the `claude-agent-acp`
adapter (`@agentclientprotocol/claude-agent-acp`, line 205) uses its own default and
talks straight to `api.anthropic.com` with the user's real OAuth bearer sitting in the
sandbox process's environment for the life of the session. `/router` (stack B) and
`/v1/llm` (stack A) are never involved. **The task briefing's claim is correct, with
the correction that this is the same code path used for the ordinary "no credential at
all, fall through to Kortix-managed" case is a *different*, later branch
(lines 557-568) — the subscription token specifically takes the direct-to-adapter
path, not the managed-gateway fallback.**

### 1.3 Correction — a first-class connect flow already exists, contrary to the briefing

The briefing states "there is reportedly no dedicated connect command or flow." Read
in full: `apps/web/src/features/workspace/customize/sections/llm-provider/forms/
claude-subscription-form.tsx` (202 lines) — a real two-step `Stepper` UI: step 1 shows
`claude setup-token` with a copy button and a link to Anthropic's own auth docs; step 2
is a password-masked paste field with live length validation, a "use with which
runtimes" picker (`UseWithRuntimes`, shared with the API-key forms), and
`upsertProjectSecret` writing `CLAUDE_CODE_OAUTH_TOKEN` encrypted
(`claude-subscription-form.tsx:66-70`). **This is not generic secret-paste** — it's a
purpose-built form, just built around Anthropic's own CLI-driven token mint
(`claude setup-token`) rather than an in-app OAuth redirect like Codex's
`chatgpt-subscription-form.tsx` (`startProjectProviderOAuth` → device-code poll loop).
The real gap versus Codex is not "no flow" — it's **no refresh, no expiry tracking, no
live health check**, and the token being forwarded raw into the sandbox instead of
resolved server-side. That's the accurate framing for Tier A.

### 1.4 Confirmed — the pinning matrix

`apps/api/src/projects/lib/composer-capabilities.ts:90-110`: `claude_subscription` →
`compatible_harnesses: ['claude']` only; `codex_subscription` → `['codex']` only.
Both API-key kinds (`anthropic_api_key`, `openai_api_key`) are already many-to-many
(`['claude','opencode','pi']` / `['codex','opencode','pi']`). This is a named,
deliberate "2026-07-15 founder decision," pinned by test
(`composer-capabilities.test.ts:150`), not a technical wall for Codex — but, per §2
below, it is very much a technical-and-legal wall for Claude.

---

## 2. Is a real Claude OAuth flow available to a third party at all?

**No.** This is not "unverified, needs more research" — it is Anthropic's explicit,
current, written policy, fetched directly from `code.claude.com/docs/en/legal-and-
compliance` in this pass (2026-07-21). Quoting verbatim, in full, because the exact
wording matters for §3's line-drawing:

> **Authentication and credential use**
>
> Claude Code authenticates with Anthropic's servers using OAuth tokens or API keys.
> These authentication methods serve different purposes:
>
> - **OAuth authentication** is intended exclusively for purchasers of Claude Free,
>   Pro, Max, Team, and Enterprise subscription plans and is designed to support
>   ordinary use of Claude Code and other native Anthropic applications. …
> - **Developers** building products or services that interact with Claude's
>   capabilities, including those using the Agent SDK, should use API key
>   authentication through Claude Console or a supported cloud provider. **Anthropic
>   does not permit third-party developers to offer Claude.ai login or to route
>   requests through Free, Pro, or Max plan credentials on behalf of their users.**
>
> Anthropic reserves the right to take measures to enforce these restrictions and may
> do so without prior notice.

Corroborating secondary sources (web search, not relied on for the exact wording, only
for dating/context): this section was added to Anthropic's legal docs around
2026-02-17/18, followed public reporting in January 2026 of enforcement action against
third-party tools that extracted Claude Code OAuth tokens for use in their own clients
([The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/);
[WinBuzzer, 2026-02-19](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)).

Two direct consequences for this task:

1. **There is no device-code or equivalent flow Kortix could build to drive Claude
   Pro/Max OAuth on a user's behalf.** The only sanctioned way to obtain a Claude
   subscription OAuth token at all is Anthropic's own client performing the browser
   round-trip — exactly what `claude setup-token` already does, and exactly what
   Kortix's existing paste-flow already uses (§1.3). **There is no "build the OAuth
   flow" project available here; manual token paste from `claude setup-token` is not a
   workaround pending a better flow — it is the ceiling.** This directly reframes the
   task, exactly as the briefing anticipated: the work is "improve custody and
   lifecycle around a pasted token," not "build parity OAuth."
2. **The bolded sentence — "route requests through Free, Pro, or Max plan credentials
   on behalf of their users" — is a near-verbatim description of the Codex-subscription
   mechanism this task was asked to port.** `/router/codex-subscription` (§1.1) is
   Kortix's own multi-tenant server resolving a stored subscription credential and
   making the outbound call to the provider *on the user's behalf*. Anthropic's policy
   names this exact shape and prohibits it for Claude credentials, full stop — it does
   not carve out an exception for "but the destination is still the real Claude Code
   binary" or "but it's server-side so the token never touches third-party software."
   The policy's prohibited unit is *routing the request*, not *where the token
   physically sits*. **This is the single most important finding of this document**
   and is addressed precisely in §3's Tier C section, because it also bears on Tier A/B,
   not only Tier C.

What I could not verify and am not asserting: whether Anthropic's Consumer Terms of
Service (the contract, as opposed to this docs-page policy statement) contains
matching contractual language, or what Anthropic's actual enforcement posture is
against a specific implementation detail like "the credential is decrypted for a
single outbound fetch, never logged, never returned to the client" (the same custody
discipline `codex-subscription.ts` already applies). Those are legal-review questions,
not code-archaeology ones, and are out of scope for this document by design — I am not
resolving the policy call, only making sure the owner has the primary source instead of
a "probably fine" assumption.

**For comparison, OpenAI's position is materially different and less explicit** (web
search, not a primary-source fetch of OpenAI's ToS in this pass): no located OpenAI
policy explicitly names "routing ChatGPT Plus/Pro credentials through a third-party
service on behalf of users" as prohibited the way Anthropic's Feb-2026 page does;
OpenAI's terms more generically prohibit "sharing account credentials" and "making
your account available to anyone else," which is more ambiguous as applied to a
server-side relay that never exposes the raw token to the end user. This asymmetry is
plausibly *why* Kortix already has a Codex relay and not a Claude one — worth stating
plainly, and worth a real legal read on the OpenAI side too if this matters, but that
is not this document's job either.

---

## 3. The three-tier plan

### Tier A — unblocked, no policy question

Everything here keeps the token exactly where it is today: forwarded to the real
`claude-agent-acp` adapter, which is (per Anthropic's own policy language) "ordinary
use of Claude Code" by the purchaser's own credential in their own project's sandbox.
Nothing in this tier relays the request through a Kortix-operated multi-tenant server
component the way `/router/codex-subscription` does — that would cross into §2's
prohibition (see the note on custody at the end of this section).

1. **A `claude` credential module mirroring `credentials/codex.ts`'s shape** — new file
   `apps/api/src/llm-gateway/credentials/claude.ts`: `resolveClaudeCredential(projectId,
   userId)` reading the same `project_secrets` row (`CLAUDE_CODE_OAUTH_TOKEN`), same
   shared/personal precedence (`loadCodexRow`'s pattern, `codex.ts:30-45`). **No
   refresh call** — unlike Codex, there is no known refresh-token exchange endpoint for
   a `claude setup-token`-minted token (unverified: whether the token has *any*
   documented refresh mechanism at all, or is a long-lived bearer with a fixed ~1-year
   expiry per public Claude Code docs/GitHub issue discussion found in §2's web search
   — this needs a direct check against what `claude setup-token`'s output actually
   contains, not assumed). This module's job in Tier A is expiry *tracking*, not
   refresh: decode/store whatever expiry metadata the token or its issuance carries (if
   any is available), and answer "is this healthy, expiring soon, or dead" without
   fabricating a refresh flow that doesn't exist.
2. **A typed health status, not a boolean.** Extend the `CredentialStatus` shape
   the credential-management doc already proposed (`absent | invalid | expired |
   healthy`, §5.6/§5.7 of `2026-07-21-llm-credential-and-model-management.md`) to
   the Claude connection row so `Connected` in the UI stops meaning only "a row
   exists" (today's `connectionConfigured` for `claude_subscription`,
   `composer-capabilities.ts:175`, is literally `Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim())`
   — presence only, no liveness check). Concretely: a lightweight "test connection"
   call (a cheap real request to Anthropic, e.g. a 1-token completion or whatever
   minimal endpoint validates a bearer without burning meaningful spend) that flips
   `invalid`/`healthy` and is callable both at connect-time and on a periodic/on-demand
   basis from the Models page.
3. **`billingMode` discipline even though there's no descriptor pointed at a relay** —
   if/when a `claudeDescriptor` is ever built (Tier B), it must set `billingMode: 'none'`,
   `markup: 0`, and the real credential, exactly like `codexDescriptor`
   (`descriptors.ts:150-168`) — named here so it's decided once, not re-derived. Not
   applicable to a pure Tier A (direct-to-adapter, no gateway involvement) since no
   Kortix billing code is in that path at all today, by construction — this is a
   forward note for whoever builds Tier B, not a Tier A deliverable itself.
4. **Fail-closed on missing/invalid credential** — today, if `claude_subscription` is
   the selected connection and the token has gone stale, `env.CLAUDE_CODE_OAUTH_TOKEN`
   is still non-empty (the row still exists, it's just expired), so
   `harness-registry.ts:542` still takes the direct branch and hands a dead token to
   the adapter — the *adapter* discovers the failure at first request, not Kortix. This
   is a materially better failure mode than the confirmed Codex leak (no silent
   billing substitution is even possible here, since there's no fallback branch to
   silently take — see §1.2/1.4 of the codex-leak doc, item 4, "no equivalent hazard").
   Still worth closing the UX gap: with item 2's health status available,
   `resolveActiveHarnessConnection`/session-start (`sessions.ts:576-612`'s
   `COMPOSER_CAPABILITY_BLOCKED` 409 gate) should refuse to start a Claude-subscription
   session on a known-`expired`/`invalid` credential *before* the sandbox boots,
   surfacing "reconnect Claude" instead of a mid-session adapter-level auth failure.
   This is a UX/reliability fix, not a billing-safety fix — Claude has no billing-leak
   hazard to close in the first place, per §1.2's re-confirmation.
5. **Revocation** — `deleteProjectSecret` already exists generically (used by every
   connect form); confirm/add an explicit "Disconnect" action on the Claude connection
   row that also invalidates any cached health-status row from item 2, so a revoked
   token doesn't show stale `healthy` state.

**Explicit note on custody, since the task asked for it directly**: "does the token
need to keep going to the sandbox verbatim, or can Claude be relayed server-side like
Codex" — **per §2, it should not be relayed server-side.** A `/router/claude-
subscription`-style endpoint, mirroring `codex-subscription.ts` exactly, is
*architecturally* trivial to build (the harness already supports pointing
`ANTHROPIC_BASE_URL` at an arbitrary endpoint with a bearer token — see the
`custom?.protocol === 'anthropic'` branch, `harness-registry.ts:549-556`, which already
does this for BYOK custom endpoints) — but it is exactly the shape Anthropic's policy
names as prohibited ("route requests through … Max plan credentials on behalf of their
users"), regardless of how carefully the custody is engineered on Kortix's side. This
is why it is filed under Tier B/C's policy question, not Tier A's "unblocked" list, even
though the codex-leak doc's mitigation pattern would make it *technically*
straightforward. Building it anyway, even behind a flag, means Kortix's own
infrastructure performs the exact act Anthropic's docs page says it will not permit and
"reserves the right to take measures to enforce... without prior notice" against — a
real business risk (API/account-level enforcement against Kortix's own Anthropic
relationship, not just the end user's), not a code-quality one.

### Tier B — depends on transport work

**Verified: the Anthropic-Messages ingress is already mounted in-API**, not just on
the standalone gateway pod. Read directly: `apps/api/src/llm-gateway/wire.ts:387-410`
(`mountLlmGateway`) registers `llm.post('/messages', messages)` and
`llm.post('/v1/messages', messages)` on the in-process gateway app, right alongside
`/chat/completions`. This confirms Correction A of `2026-07-21-gateway-universal-
transport-plan.md` (§0) rather than contradicting it — that doc already caught this
and it holds up on re-read. **Concretely: whatever ingress cost the owner might have
assumed still needed building for Claude's wire shape does not exist** — it shipped
already, for a different purpose (BYOK/managed Anthropic-Messages traffic), and is
sitting unused by the Claude ACP harness.

What Tier B would actually still need, **if and only if** the owner decides (post-§2)
that a gateway-mediated Claude path is worth pursuing under one of the constrained
shapes in §4's Tier-C discussion (e.g., scoped to Kortix's *own* project/account,
never multi-tenant relay of other users' tokens):

1. `claudeDescriptor` + `resolveClaudeCredential` pair (Tier A item 1, promoted to
   also emit an `UpstreamDescriptor`), landed as **additive, unreachable** code —
   exactly the sequencing the transport-plan doc already recommends (§5 step 2) —
   until something explicitly requests it.
2. A `provenance` trace field (transport-plan doc §2.3) so subscription-attributed
   traffic is distinguishable from "free tier, nothing to bill" in reporting — small,
   additive schema change, should land before any real Claude-subscription traffic
   flows through stack A, not after (retrofitting historical rows isn't possible).
3. Nothing new needed on the ingress/wire-format side — that gap, unlike Codex's/Pi's
   still-missing Responses-shaped ingress, is already closed.

**This tier should stay unbuilt until the owner has made the §2 call**, because the
only reason to build a `claudeDescriptor` at all is to eventually point something at
it, and the only something available (a session relay) is the thing §2 flags as
policy-risky. Building the descriptor "just in case, unreachable" is low-risk in
isolation (transport-plan doc's own framing) but has no product value until Tier C (or
a narrower Kortix-owned-account variant of it) is greenlit.

### Tier C — blocked on an unresolved ToS/policy call

The task asks for the precise technical distinction, not a resolution. Here it is,
stated as sharply as the evidence supports:

**The technical distinction that seemed plausible going in:** "if Claude's requests
are relayed server-side and the token never moves to third-party software, is that
materially different from handing the token to OpenCode?" The intuition is that
`claude-agent-acp` is Anthropic's own official adapter (arguably "Claude Code" for
policy purposes), while OpenCode/Pi are unrelated third-party agent harnesses that
happen to speak an OpenAI-compatible or custom wire format — so relaying *into*
`claude-agent-acp` specifically might read as "ordinary use of Claude Code," while
handing the same token to OpenCode plainly would not.

**Why that distinction does not survive contact with the actual policy text (§2):**
Anthropic's prohibition is not phrased in terms of *which client software* ends up
holding the token or receiving the response — it is phrased in terms of *who performs
the routing and on whose behalf*: "does not permit third-party developers to … route
requests through Free, Pro, or Max plan credentials on behalf of their users." A
Kortix-operated relay endpoint that resolves any given user's stored Claude credential
and forwards the request — regardless of whether the downstream consumer is the real
`claude-agent-acp` process, OpenCode, or Pi — is Kortix (a third-party developer)
routing a request through a Max-plan credential on behalf of the user who owns it. **The
harness-identity of the downstream consumer does not change which party is performing
the act the policy names.** So:

- **Today's actual mechanism (§1.2)** — the token forwarded verbatim into the sandbox,
  where the real `claude-agent-acp` process itself makes the direct call to
  `api.anthropic.com` — sits on the defensible side of the line: Kortix never touches
  the request between the user's stored credential and Anthropic's servers; the
  *user's own sandboxed instance of Claude Code* does. This reads as "ordinary use of
  Claude Code... by the purchaser," matching the policy's stated intent.
- **Any Kortix-operated relay** (Tier A's rejected custody option, Tier B's blocked
  descriptor-backed path, or Tier C's OpenCode/Pi reuse) **moves the act of routing
  from the user's own client to Kortix's own server**, regardless of what sits on the
  other end. This is the same shape whether the destination is `claude-agent-acp`,
  OpenCode, or Pi — **the OpenCode/Pi case is not a separate, worse violation of a
  distinct rule; it is the same violation, just more obviously so because there is no
  argument at all that OpenCode is "Claude Code."** Concretely: relaying into
  `claude-agent-acp` server-side does not buy back the exemption, because the policy's
  prohibited unit (third-party routing on the user's behalf) is already crossed before
  the request reaches whichever downstream client consumes it.

**So the narrower technical question the owner posed has a clean answer: no, relaying
through `claude-agent-acp` specifically is not materially different from relaying into
OpenCode, under the text of Anthropic's own policy.** Both are "a third party routing
requests through a Max-plan credential on behalf of a user"; neither is "ordinary use
of Claude Code by the purchaser." The only mechanism that stays clearly inside the
policy's stated intent is the one already shipped: token → sandbox → real Claude Code
adapter → Anthropic, with Kortix never in the request path.

**Restating the task's own flag, confirmed rather than just repeated:** yes — any
server-side relay of a Claude subscription token, for *any* destination harness, is
structurally the same shape as the Codex `/router/codex-subscription` path (§1.1), and
if built at all would need the identical `billingMode: 'none'` / fail-closed discipline
to avoid recreating the exact billing leak documented in `2026-07-21-codex-billing-
leak-verification.md`. That discipline is necessary but not sufficient here — it
solves the *billing-correctness* problem the Codex doc was about, but does nothing
about the *policy* problem this document surfaces, which is a different axis entirely
and is not resolved by careful engineering.

**Not resolved here, per instructions — the owner's call, not mine:**
- Whether Kortix should build the OpenCode/Pi-via-Claude-subscription reuse at all,
  given the above.
- Whether there's a materially different posture available if the relay is scoped
  narrowly (e.g., only ever the requesting user's own token, never pooled/shared
  across accounts, with contractual/ToS review) — this document does not have the
  legal expertise to say whether that narrows the risk or whether the policy's "on
  behalf of their users" language forecloses it regardless of scoping.
- Whether Anthropic's enforcement in practice (per the January 2026 reporting cited in
  §2) has targeted this specific pattern (multi-tenant platform relay with server-side
  custody) or only the cruder pattern (extracting and directly reusing raw tokens in
  another client) — the two are related but not proven identical in enforcement
  practice, only in the policy text's plain language.

---

## 4. Ordered implementation plan (Tier A, plus what's cheap in Tier B)

Numbered for sequencing; each states what it touches and what it needs tested. None of
this requires the Tier C policy call to be made first — everything here is safe to ship
regardless of how that question resolves, because it never introduces a relay.

1. **`apps/api/src/llm-gateway/credentials/claude.ts`** — new file, mirroring
   `credentials/codex.ts`'s read path (`loadCodexRow`'s shared/personal precedence,
   `codex.ts:30-45`) for `CLAUDE_CODE_OAUTH_TOKEN`. No refresh call (per §3 Tier A
   item 1's caveat — verify first whether `claude setup-token` output carries any
   refresh material at all; if not, this module is read-only). **Higher-risk item
   embedded here**: none of this touches money, but it does touch a live credential
   read path — needs unit tests mirroring `codex.ts`'s existing coverage (shared vs.
   personal row precedence, missing-row → `null`, decrypt failure handling) plus a
   test confirming it is *never* imported by anything under `apps/api/src/router`
   (the same "stack B never sees this" invariant the codex-leak fix depends on).
2. **Typed `CredentialStatus` for the Claude connection** — extend
   `composer-capabilities.ts`'s `connectionConfigured` case for `claude_subscription`
   (currently `Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim())`, line 175) to return a
   richer status once item 1's module can evaluate expiry/liveness, following the
   `CredentialStatus` (`absent | invalid | expired | healthy`) shape already proposed
   in `2026-07-21-llm-credential-and-model-management.md` §5.7. **API response shape
   change** — grep every UI/SDK caller reading `ready`/`status` on a
   `HarnessConnection` before landing (the credential-management doc flags this exact
   grep as not-yet-done in Part 4 step 2; do it as part of this step, don't assume it's
   still clean). Tests: `composer-capabilities.test.ts` needs new cases for each status
   value; a snapshot/contract test on the `/harness-connections` response shape.
3. **A cheap live "test connection" check** for Claude, callable from the connect flow
   and periodically/on-demand from the Models page — the concrete mechanism behind
   item 2's `healthy`/`invalid` distinction. **Higher-risk item**: this makes a real
   authenticated call to Anthropic using a real user credential; needs a rate limit
   (don't let the UI hammer it), and needs to run through the same "never log the raw
   token, never echo it to any response" discipline `codex-subscription.ts` already
   documents (lines 42-45) even though this check never proxies actual session
   traffic. Tests: mock the Anthropic call, cover expired/invalid/healthy/network-error
   branches distinctly (don't conflate "Anthropic is down" with "token is bad" — same
   class of bug the Codex refresh path already guards against with its grace-period
   logic, `codex.ts:107-117`).
4. **Fail-closed session-start gate** — `apps/api/src/projects/lib/sessions.ts:576-612`'s
   `COMPOSER_CAPABILITY_BLOCKED` 409 path already exists; wire item 2's status into it
   so a session cannot start on a Claude-subscription connection known to be
   `expired`/`invalid`, surfacing a "reconnect Claude" error instead of letting the
   sandbox boot and fail at first adapter request. Tests: extend
   `harness-capability-conformance.test.ts`'s existing pattern with an
   expired-Claude-credential case; verify the 409 body carries enough detail for the
   UI to route straight to reconnect (matching the shape the Codex-subscription proxy
   already returns on 401, `codex-subscription.ts:79-84`).
5. **Explicit "Disconnect" wiring** for the Claude connection row, invalidating any
   cached health-status row from item 3 on disconnect (`deleteProjectSecret` already
   exists generically — confirm/wire the UI action and the cache-invalidation, not new
   backend surface). Tests: a disconnect → immediate `absent` status assertion,
   covering the specific bug class of "shows healthy after the user just revoked it."
6. **(Tier B, cheap, ship only if the owner wants the descriptor to exist unreachable
   for future optionality)** `claudeDescriptor` in `descriptors.ts`, additive, mirroring
   `codexDescriptor`'s shape (`billingMode: 'none'`, `markup: 0`, real credential,
   `resolvedModel`). Not reachable by anything until a future decision wires a caller
   to it. Tests: unit test the descriptor shape only (no live call) — same posture as
   the transport-plan doc's own sequencing recommendation (§5 step 2, "additive,
   unreachable until something requests it").

**What this plan deliberately excludes, and why**: no `/router/claude-subscription`
relay endpoint, no change to `harness-registry.ts`'s direct-to-adapter branch
(§1.2/§3 Tier A closing note), no widening of `claude_subscription`'s
`compatible_harnesses` beyond `['claude']`. All three are the Tier C items blocked on
§2's policy question, not oversights.

---

## What I did not verify (carried forward honestly, not silently dropped)

- Whether `claude setup-token`-issued tokens have any refresh mechanism at all, or a
  fixed unrefreshable expiry (public reporting found in §2's search suggests ~1 year,
  materially longer than the ~24h/~1h TTLs reported for interactive `/login` sessions,
  but this was not confirmed against Anthropic's own documentation of `setup-token`
  specifically, only secondary sources).
- Anthropic's Consumer Terms of Service contract language itself (as opposed to the
  docs-page policy statement quoted verbatim in §2) — the docs page is Anthropic's own
  current public statement of the rule and is treated here as authoritative for
  purposes of this assessment, but a full legal review would read the actual Terms.
- Anthropic's real-world enforcement posture toward a carefully custody-controlled
  server-side relay specifically (as opposed to the cruder token-extraction pattern
  the January 2026 enforcement action reportedly targeted, per secondary sources) —
  flagged in §3 Tier C as a real open gap in the evidence, not resolved.
- Whether OpenAI's Codex/ChatGPT subscription terms actually permit what Kortix's
  existing `/router/codex-subscription` mechanism does, or whether that mechanism
  carries analogous (if less explicitly documented) policy risk on the OpenAI side —
  noted in §2 as a live asymmetry worth its own review, not resolved here since it is
  outside this task's Claude-specific scope.
