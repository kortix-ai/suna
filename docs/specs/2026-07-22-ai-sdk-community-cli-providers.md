# AI SDK community CLI-wrapper providers — what they do, and whether Kortix wants them

Status: research only, for owner read. No code changed.
Date: 2026-07-22
Scope: `acp-harness-runtime-v2` worktree, read-only pass. Triggered by the owner finding
https://ai-sdk.dev/providers/community-providers/codex-cli and
https://ai-sdk.dev/providers/community-providers/claude-code and asking what they actually
do, and whether the answer is "format" or "auth."

**Headline answer to the owner's question: auth, not format.** The wire format these
packages produce (AI SDK `LanguageModelV2`/`V3` streaming events) is a solved, boring
problem — every provider on ai-sdk.dev does that. The entire reason these three packages
exist, and the entire reason 440k/month of npm downloads want them, is that they let AI
SDK application code (`generateText`/`streamText`) drive an **already-authenticated local
agent CLI** instead of calling a hosted API with a key. That is a credential-custody
mechanism wearing a `LanguageModel` interface, not a transport-format library.

---

## Part 1 — What they are, precisely

Verified by reading each package's own docs/README (`ai-sdk.dev` provider pages +
`raw.githubusercontent.com/.../README.md`) and cross-checked against the npm registry and
GitHub API (`registry.npmjs.org`, `api.github.com`) for versioning, download volume, and
maintenance activity, all fetched 2026-07-22.

### 1.1 `ai-sdk-provider-claude-code`

**What it does, mechanically**: spawns the `claude` CLI binary as a child process, built on
top of `@anthropic-ai/claude-agent-sdk` (the current package's 4.x line pins
`@anthropic-ai/claude-agent-sdk@0.3.205` exactly; it migrated off the older
`@anthropic-ai/claude-code` package name at v2.0.0). It is not an HTTP client against
`api.anthropic.com` — it is a driver of the real, local, interactive Claude Code
installation.

**Auth**: requires the user to have already run `claude auth login` (or the equivalent —
any flow that leaves the CLI in a logged-in state). The package does **not** offer an
`ANTHROPIC_API_KEY`-style escape hatch as an alternative credential path documented on its
own README — it is built around "you already have a working, authenticated `claude`
install on this machine," full stop. Every request the AI SDK caller makes rides on top of
whatever session/OAuth state the CLI itself is holding — i.e., **a Claude Pro/Max
subscription** in the common case, with no API key touched anywhere in the request path.

**AI SDK feature support**: `streamText`/`generateText`, multi-turn, image input
(base64/data-URL only, no remote URL fetch), native structured output via
`Output.object({schema})` (AI SDK v7 shape; the older `generateObject()`/`streamObject()`
pattern is documented as no longer the recommended path), `AbortSignal`, MCP server
attachment. **Not supported**: AI SDK's own `tools` option / Zod-schema tool-calling — the
CLI runs its own built-in tool loop (Bash, Edit, Read, Write, …) and the only way to add
tools is bridging them in as an MCP server the CLI itself connects to, not via the AI SDK
tool-call protocol. Sampling knobs (`temperature`, `topP`, `topK`, penalties, `seed`,
`maxOutputTokens`) are accepted but ignored with a warning — the CLI doesn't expose them.
Notably rich `providerMetadata` surface: `ttftMs`, `costUsd`, `durationMs`,
`warmSpareClaimed`, session id, token breakdown — this package is tracking cost/latency
the CLI itself reports, which the raw Anthropic API wouldn't hand back the same way.

**Maturity**: package created 2025-06-19, latest publish 2026-07-11 (11 days before this
doc), 48 published versions, actively tracking AI SDK v7 (`ai-sdk-v6` kept as a separate
maintenance dist-tag). 357 GitHub stars, 1 open issue, not archived, last push 2026-07-11.
440,067 npm downloads in the 30 days ending 2026-07-20. Maintainer: Ben Vargas (a solo
community maintainer, not Anthropic or Vercel).

Sources: [ai-sdk.dev/providers/community-providers/claude-code](https://ai-sdk.dev/providers/community-providers/claude-code),
[github.com/ben-vargas/ai-sdk-provider-claude-code](https://github.com/ben-vargas/ai-sdk-provider-claude-code)
(README fetched via raw.githubusercontent.com 2026-07-22), npm registry + npm downloads API,
GitHub repo API.

### 1.2 `ai-sdk-provider-codex-cli`

**What it does, mechanically**: same shape as 1.1, for OpenAI's `codex` CLI, but with two
distinct modes documented explicitly: `codexExec` spawns a fresh `codex exec
--experimental-json` process per call (simple, but only returns the full response as one
chunk — no true incremental streaming), and `codexAppServer` maintains one persistent
JSON-RPC child process across calls, which is the mode that gets real streaming deltas.
Depends on `@openai/codex` (pinned `^0.144.0`); prefers a locally installed copy and falls
back to `npx -y @openai/codex` if `allowNpx: true` is set.

**Auth**: two paths, both documented — (a) preferred: `codex login`, which stores tokens at
`~/.codex/auth.json`, i.e. the **ChatGPT Plus/Pro subscription** path, identical in shape to
Kortix's own `CODEX_AUTH_JSON`; (b) fallback: export `OPENAI_API_KEY`, forwarded straight
through to the spawned process. Unlike the Claude package, this one explicitly supports
both doors.

**AI SDK feature support**: `generateText`, `streamText`, `generateObject` (via native JSON
Schema — Zod schemas get flattened to JSON Schema and Zod's `strict`-mode quirks apply: all
fields must be required, format validators/regex get stripped), image input (local file,
base64, and — unlike the Claude package — remote URLs), reasoning-effort configuration
(`none|minimal|low|medium|high|xhigh`), tool-call *observation* through streaming events.
**Not supported**: AI SDK's own `tools`/Zod tool schemas driving the CLI's tool loop — same
limitation as 1.1, for the same reason (Codex runs its own autonomous tool executor).
Sampling knobs ignored with a warning, same as 1.1.

**Version coupling**: tightly pinned — the README states plainly it "requires the current
stable Codex CLI 0.144.x for full support of both provider modes." This is a real
maintenance cost: every Codex CLI release potentially breaks or degrades this wrapper until
it republishes.

**Maturity**: created 2025-08-19, latest publish 2026-07-11, 29 published versions, on AI
SDK v7 (`v2.x`) with v6/v5/v4 kept as maintenance tags. 66 GitHub stars, 0 open issues, not
archived. 355,079 npm downloads in the trailing 30 days. Same maintainer, Ben Vargas.

Sources: [ai-sdk.dev/providers/community-providers/codex-cli](https://ai-sdk.dev/providers/community-providers/codex-cli),
[github.com/ben-vargas/ai-sdk-provider-codex-cli](https://github.com/ben-vargas/ai-sdk-provider-codex-cli),
npm registry + downloads API, GitHub repo API.

### 1.3 Sibling: `ai-sdk-provider-gemini-cli`

Same maintainer (Ben Vargas), same shape: wraps the local `gemini` CLI via
`@google/gemini-cli-core`. Auth is the widest of the three — Google-account OAuth via the
CLI's interactive login (the subscription-equivalent path), a Google AI Studio API key, or
Vertex AI / Google Auth Library credentials for enterprise GCP setups. Supports image input,
object generation, tool usage/streaming, and Gemini's "thinking" reasoning config. Much
smaller adoption: 45,110 downloads/month (roughly a tenth of the other two) — consistent
with Gemini CLI itself having a smaller installed base than Claude Code/Codex CLI.
Source: [ai-sdk.dev/providers/community-providers/gemini-cli](https://ai-sdk.dev/providers/community-providers/gemini-cli).

### 1.4 Other entries on the community-providers page

The full list, per the ai-sdk.dev community-providers index, also includes a
**Codex CLI (App Server)** variant (the persistent-process mode described in §1.2, listed
as its own doc page rather than a separate package), and separately, non-agent-CLI entries:
**OpenCode** (an AI SDK provider that lets AI SDK code call *out to* an OpenCode server as a
model backend — the inverse relationship of what this document is about), **llama.cpp** and
**Ollama** (local inference-engine runners — no subscription/auth angle at all, they're
plain local HTTP servers over local model weights). These three are not agent-CLI-wrapping-
for-subscription-auth packages and are not analyzed further here; they don't bear on the
owner's question.

### 1.5 The auth answer, one sentence

All three CLI-wrapper packages exist to let AI SDK application code drive an
**already-logged-in** local agent CLI so requests ride on that CLI's own session — for
Claude Code and Codex CLI specifically, that session is normally a **Pro/Max or ChatGPT
Plus/Pro subscription**, with no API key anywhere in the path unless the user (Codex only)
explicitly opts into the `OPENAI_API_KEY` fallback.

### 1.6 Maturity summary

| Package | npm downloads/30d | GitHub stars | Open issues | Last publish | Version coupling |
|---|---|---|---|---|---|
| `ai-sdk-provider-claude-code` | 440,067 | 357 | 1 | 2026-07-11 | Tracks `@anthropic-ai/claude-agent-sdk` exactly (pinned) |
| `ai-sdk-provider-codex-cli` | 355,079 | 66 | 0 | 2026-07-11 | Tracks Codex CLI `0.144.x` exactly (pinned, stated in README) |
| `ai-sdk-provider-gemini-cli` | 45,110 | — (not fetched) | — | — | Tracks `@google/gemini-cli-core` |

All three are single-maintainer (Ben Vargas) community packages, not published or endorsed
by Anthropic/OpenAI/Google/Vercel. Active and reasonably well-adopted, but a bus-factor-of-one
dependency with a maintenance model of "republish when the underlying CLI moves" — worth
weighing against Kortix's own "pinned exact versions, provenance-verified" bake discipline
(`efc5c319e`, §2.1 below).

---

## Part 2 — Relevance to Kortix

Grounded against: `docs/specs/2026-07-21-claude-subscription-parity.md` (Anthropic's own
"does not permit third-party developers to... route requests through Free, Pro, or Max plan
credentials on behalf of their users" policy, quoted verbatim there from
`code.claude.com/docs/en/legal-and-compliance`, and its Tier A/B/C plan built around that
finding); `docs/specs/2026-07-22-unified-auth-gateway.md` (the shipped
`CREDENTIAL_CUSTODY: Record<HarnessAuthKind, CredentialCustody>` table — `claude_subscription:
'direct-only'`, `codex_subscription`/everything else `'relay-eligible'` — and the pinning
matrix `claude_subscription → compatible_harnesses: ['claude']` only,
`composer-capabilities.ts:90-110`, a named 2026-07-15 founder decision); and freshly read in
this pass: `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts` (the ACP harness
launch/auth-isolation logic), `apps/kortix-sandbox-agent-server/src/acp/opencode-gateway.ts`
(OpenCode's custom-provider injection mechanism), `packages/starter/templates/base/.opencode/
opencode.jsonc` (the shipped OpenCode config shape), and commit `efc5c319e` ("bake official
claude/codex CLIs... into every sandbox image").

### 2.1 In-sandbox use

**The mechanical question first: could OpenCode load `ai-sdk-provider-claude-code` as a
custom model provider inside a Kortix sandbox?** Yes, mechanically — confirmed by reading
`opencode-gateway.ts:209-228`, `buildOpencodeKortixProvider()`. OpenCode's provider
injection is already exactly this shape: a JSON block with an `npm:` field naming an AI SDK
provider package (today it emits `npm: '@ai-sdk/openai-compatible'` for Kortix's own managed
gateway), an `options` bag passed to that package's constructor, and a `models` catalog.
OpenCode's provider abstraction is genuinely swappable-by-npm-package-name — this is not a
hack Kortix invented, it's the documented extension point, and `ai-sdk-provider-claude-code`
is exactly the shape (`ProviderV2`-compatible export) that mechanism expects. Since
commit `efc5c319e`, every sandbox already bakes the real `claude` and `codex` binaries
(`@anthropic-ai/claude-code`, `@openai/codex`), pinned exact versions, provenance-verified —
so the binary the wrapper package would spawn is already present on PATH in every sandbox,
today, for both providers.

**But here is the load-bearing fact that changes the shape of the question: Kortix already
gives sandboxes real Claude Code access, today, via a more official mechanism than this
wrapper.** The dedicated `claude` ACP harness (`harness-registry.ts:540-548`, verified in
`2026-07-21-claude-subscription-parity.md` §1.2 and re-confirmed present in this pass) already
forwards `CLAUDE_CODE_OAUTH_TOKEN` verbatim into the sandbox and lets
`@agentclientprotocol/claude-agent-acp` — Anthropic's own published ACP adapter — drive the
real `claude` binary directly against `api.anthropic.com`, with Kortix's server never in the
request path. That is the *same category* of thing `ai-sdk-provider-claude-code` does
(spawn/drive the locally-authenticated CLI), except:

- it uses Anthropic's own official adapter (`claude-agent-acp`) instead of a
  single-maintainer community wrapper library,
- it's already shipped, already custody-audited (`CREDENTIAL_CUSTODY.claude_subscription =
  'direct-only'`), and already the subject of the owner's own prior policy review (the parity
  doc, §3 Tier A/§4).

So `ai-sdk-provider-claude-code` does **not** unlock something Kortix sandboxes lack — it
would only be relevant for one narrower case: **letting the `opencode` harness specifically**
(not the dedicated `claude` harness) **consume a user's `CLAUDE_CODE_OAUTH_TOKEN`.** Today
that's blocked by product policy, not technology: `claude_subscription`'s
`compatible_harnesses` is pinned to `['claude']` only (`composer-capabilities.ts:90-110`, a
named, deliberate decision per the unified-auth-gateway doc, not a technical wall). If the
owner ever wants "run OpenCode, but pay with your Claude subscription instead of an API
key," `ai-sdk-provider-claude-code` is the concrete technical mechanism to do it *without*
building a server-side relay: OpenCode, running inside the user's own sandbox, spawns the
same already-authenticated `claude` binary already sitting in that same sandbox. **Kortix's
server is not a party to that request any more than it is today with the `claude` harness** —
same custody shape, same "direct-only," just a different local process doing the spawning.

**Honest ToS framing (not a legal conclusion, laid out as a spectrum for the owner)**:

1. A user typing directly into their own terminal — unambiguously fine, the paradigm case of
   "ordinary use... by the purchaser" the policy text names.
2. Today's shipped `claude` ACP harness — Anthropic's own published integration surface
   (`claude-agent-acp`) driving the CLI inside the user's own sandboxed environment. As close
   to "official" as a third party gets; this is the shape the parity doc's §3 Tier A concludes
   is defensible, and it's already built and shipping.
3. `ai-sdk-provider-claude-code` inside OpenCode — an **unofficial** community library,
   published by neither Anthropic nor Kortix, spawning the same binary from inside the same
   user-owned sandbox. One step further from "official" than (2), but the same "who initiates
   the request" answer: the user's own already-authenticated local process, not a
   Kortix-operated multi-tenant server. This is the same general shape Zed's agent panel and
   OpenCode's own upstream project already do widely (both are third-party editors/agents that
   drive locally-authenticated `claude`/other subscription CLIs on the user's machine) without
   reported Anthropic enforcement action against that pattern specifically — the January 2026
   enforcement reporting cited in the parity doc (§2) targeted *token extraction into another
   client's own auth store*, not "a local wrapper process invokes the CLI you're already logged
   into, in place." Not the same act, and worth naming as such, but this document does not
   resolve whether Anthropic's policy text ("third-party developers... rout[ing] requests...
   on behalf of their users") reads a locally-spawned wrapper as materially different from a
   server relay — a genuine gap in the evidence, flagged rather than assumed.
4. What the policy clearly forbids and Kortix has already correctly avoided (per the parity
   doc's §2/§3 Tier C in full): a **Kortix-operated server-side relay** of a Claude
   subscription token to any destination, `claude-agent-acp` included. Nothing in this
   document changes that conclusion — a CLI-wrapper npm package running *inside the user's
   own sandbox* is not that shape at all, regardless of which npm package does the spawning.

**Recommendation: consider, not adopt now.** The underlying capability (drive Claude Code
with the user's own subscription, no relay) is already shipped via the dedicated `claude`
harness. `ai-sdk-provider-claude-code` only buys something new if the product goal becomes
"let OpenCode sessions specifically use a Claude subscription" — and if that goal is ever
prioritized, lifting the `claude_subscription → ['claude']` pin is the real product decision;
this wrapper package is just the plumbing once that's decided. Not worth building
speculatively.

**Codex-cli wrapper vs. Kortix's existing server-side relay — no reason to prefer the CLI
wrapper.** Kortix already has `/router/codex-subscription` (`apps/api/src/router/routes/
proxy/codex-subscription.ts`, per the parity doc §1.1), a working, already-sanctioned
(OpenAI's terms are materially less explicit about this pattern than Anthropic's, per the
parity doc §2's comparison), already-custody-audited (`billingMode: 'none'`, fail-closed)
server relay for Codex. It's simpler (no local process spawn, no CLI-version pinning cost,
works from any surface, not only sandboxes that happen to have the `codex` binary), already
ships, and already covers "opencode/pi use a Codex subscription" for any harness whose
`compatible_harnesses` includes `codex_subscription` — which per the parity doc's pinning
table, unlike Claude, is not artificially narrowed. Adding `ai-sdk-provider-codex-cli` on top
would mean maintaining a second, less-official, version-pinned path to the exact same
outcome the relay already delivers more simply. **Say it plainly: probably not, no
identified use case beats the existing relay.**

### 2.2 Server-side/gateway use

**Plainly: no sane fit, and this document says so directly rather than hedging.** The
gateway (per this branch's own `984c4b8b1` — AI-SDK-native transport, multi-tenant,
autoscaled) has no single "logged-in user" identity to spawn a CLI as. A `claude`/`codex`
process spawned on a gateway host would need to be authenticated as *someone's* subscription
— there is no tenant-neutral answer to "whose login," and running one warm CLI process per
authenticated end-user on shared gateway infrastructure defeats the gateway's own
stateless/autoscale design (compare: a gateway pod today serves arbitrary tenants
per-request; a CLI-wrapper provider would pin a pod to one user's authenticated OS-level
process state). Worse, for Claude specifically, this is not merely impractical — it is
**exactly** the server-side relay shape the parity doc's §2/§3 Tier C already identifies as
crossing Anthropic's stated policy line, just implemented by spawning a CLI instead of
forwarding raw HTTP. Routing the request through a Kortix-operated server component "on
behalf of" the token's owner is the same act regardless of whether the intermediary makes an
HTTP call or execs a subprocess — the parity doc's own Tier C reasoning (§3, "the
harness-identity of the downstream consumer does not change which party is performing the
act the policy names") applies without modification to "the downstream consumer is a
CLI-wrapper library" too. **Verdict: ignore.**

### 2.3 Format learnings

Three things worth citing as independent confirmation of choices Kortix has already made —
none require new code:

1. **Persistent-process vs. spawn-per-call, and what each buys you.**
   `ai-sdk-provider-codex-cli`'s own docs are explicit that only its persistent
   `codexAppServer` JSON-RPC mode gets true incremental streaming deltas; its simpler
   `codexExec` (fresh process per call) mode returns the full response in one chunk. Kortix's
   ACP harnesses (`claude-agent-acp`, `codex-acp`, `opencode acp`, per
   `harness-registry.ts`) are already all long-lived JSON-RPC processes, not spawn-per-turn —
   this is independent third-party confirmation that the persistent-process architecture
   Kortix already committed to is the one that actually gets real streaming, not a
   simplification worth reconsidering.
2. **Tool calls are bridged via MCP, not injected as provider-level tool schemas — in both
   directions.** Neither community wrapper exposes AI SDK's `tools`/Zod-schema tool-calling to
   the underlying CLI; both document that the only way to add tools is via MCP, because the
   CLI owns its own autonomous tool loop and there's no clean way to hand it foreign
   tool-call semantics. This is the same shape Kortix's ACP bridge already lives in (each
   harness runs its own native tool loop; Kortix's tool surface is added via MCP, not by
   faking an AI-SDK-shaped tool schema into a harness that doesn't natively speak it) — good
   independent validation, nothing to change.
3. **`providerMetadata` as the place to surface CLI-native telemetry.**
   `ai-sdk-provider-claude-code` returns `ttftMs`, `costUsd`, `durationMs`,
   `warmSpareClaimed`, and session id inside `providerMetadata['claude-code']` rather than
   inventing new top-level response fields. If Kortix's own gateway or ACP bridge ever wants
   to expose harness-native telemetry (cost/timing/session data the AI-SDK-native gateway
   transport wouldn't otherwise carry) through to callers, `providerMetadata` is the idiomatic
   AI SDK slot to put it in — worth keeping in mind for the gateway's own AI-SDK-transport
   work (`984c4b8b1`), not an action item today.

---

## Recommendation summary

| Item | Verdict | Why |
|---|---|---|
| `ai-sdk-provider-claude-code` for OpenCode-in-sandbox | **Consider** (not urgent) | Real technical mechanism to let `opencode` (not just the dedicated `claude` harness) spend a Claude subscription, entirely within existing "direct-only" custody — no relay. Only worth building if/when the owner decides to lift the `claude_subscription → ['claude']` harness pin; the underlying capability (Claude Code, user's own subscription, no relay) already ships via the `claude` harness today. |
| `ai-sdk-provider-codex-cli` for OpenCode-in-sandbox | **Ignore** | Kortix's existing `/router/codex-subscription` server relay already covers this need, more simply, already sanctioned, already shipped. No identified advantage to the CLI-wrapper path. |
| `ai-sdk-provider-gemini-cli` / other CLI wrappers | **Ignore** | No Gemini-subscription-parity product need identified; smallest adoption of the three (45k/mo vs 350-440k/mo). Revisit only if Gemini subscription support becomes a roadmap item. |
| Any CLI-wrapper provider on the gateway/server side | **Ignore, plainly** | Multi-tenant nonsense (no single "whose login" answer, breaks stateless autoscaling) and, for Claude specifically, re-crosses the exact server-relay policy line the parity doc already resolved against. |
| Format/architecture learnings (persistent-process streaming, MCP-for-tools, `providerMetadata` telemetry) | **Adopt as confirmation** | All three already match decisions Kortix's ACP bridge has already made; no new code needed, just independent validation worth citing. |

**The one decision only the owner can make**: whether "let OpenCode sessions use a
connected Claude subscription" (lifting `claude_subscription`'s harness pin from `['claude']`
via a mechanism like `ai-sdk-provider-claude-code`) is worth doing at all, given it trades
Anthropic's own official adapter (already shipped, already reviewed) for an unofficial
single-maintainer community wrapper performing the same category of act one notch further
from "official" — not a technical question, a product-priority-plus-ToS-posture one, same
family of call as the parity doc's still-open Tier C question. Nothing in this document
resolves it; it only confirms the mechanism would work and states the trade-off plainly.

## What was not verified

- Whether Anthropic's or OpenAI's enforcement posture has ever specifically targeted
  community CLI-wrapper libraries like these (as opposed to the token-extraction pattern the
  parity doc's cited January 2026 reporting covers) — not located in this pass, flagged as an
  open gap rather than assumed either way.
- The exact `ProviderV2` compatibility surface of `ai-sdk-provider-claude-code`/`-codex-cli`
  against the specific AI SDK version OpenCode itself bundles — confirmed the packages target
  AI SDK v7 and OpenCode's own provider loader accepts arbitrary `npm:`-named AI SDK
  providers (`opencode-gateway.ts`'s existing use), but a live install-and-load smoke test was
  not run in this read-only pass.
- GitHub star/issue counts for `ai-sdk-provider-gemini-cli` (not fetched; only npm download
  volume was pulled for that package).
