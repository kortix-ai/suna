# LLM credential and model management — architecture investigation

Status: read-only investigation, no code changed
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510 (four ACP harnesses: Claude Code,
Codex, OpenCode, Pi)
Author: Claude (investigation agent), for Marko

This is a research document, not an implementation. Every claim in Part 1 is
grounded at `file:line`. Parts 2-4 are analysis and proposal built on that
evidence. Anything not directly observed in code is explicitly marked
**unverified**.

**Headline finding**: this exact problem was already specced in detail on
2026-07-14 (`docs/specs/2026-07-14-provider-auth-model-management.md`,
`docs/specs/2026-07-14-models-page-ui-handoff.md`) and roughly 70% of that
spec's UI vision is already built (a unified "Models" page on web and mobile,
subscription OAuth flows, a many-to-many auth-kind→harness compatibility
table). What shipped, however, is a **deliberately reduced version** of the
spec's data model — singleton connections instead of the spec's multi-instance
`ModelConnection` records — plus two "founder decisions" (2026-07-15) that
directly contradict what you're now asking to reconsider: subscriptions are
hard-pinned to their own harness only, by policy, not by technical necessity in
one of the two cases. There is also a live, code-provable bug class (not yet
filed) where a harness can be told "you're ready to start" when the resolved
route has literally no model behind it — the most likely root cause of the
hang you hit.

---

## Part 1 — What exists today

### 1.1 Two credential systems, not one

Contrary to the "it's all a mess" framing, the code already has a fairly
disciplined **project-scoped credential model** for harness auth. But there is
a **second, older, parallel system** for the managed gateway's own default
model, and the two are bolted together on the same UI page without being
unified.

**System A — project secrets** (`apps/api/src/projects/secrets.ts`)
Generic encrypted KEY=value store, AES-256-GCM per-project-derived key
(`projectSecretKey`, secrets.ts:49-61). Two orthogonal axes:
- **scope**: `'runtime'` (reaches the sandbox env) vs `'connector'` (Pipedream/
  executor-resolved, never reaches the sandbox — secrets.ts:165-166).
- **ownership**: `ownerUserId IS NULL` = shared/project-wide row; a non-null
  `ownerUserId` = one user's personal override of the same `identifier`
  (secrets.ts:175-179, `listResolvedProjectSecrets`, secrets.ts:194-231). A
  personal row wins over the shared row only if `active` (secrets.ts:226).

This is the mechanism the memory file's "BYOK private-key gateway blindness"
incident was about, but that bug was in the **managed-gateway BYOK path**
(account-level provider keys resolved by `apps/api/src/llm-gateway/**`), a
different table/path from project-scoped harness-auth secrets described here.
I did not re-audit that separate BYOK path in this pass — flagging it as an
**adjacent but distinct** credential store worth folding into any unified
design (see Part 3).

**System B — the gateway's own default-model chain**
`docs/specs/default-model-resolution.md` (2026-06-28, "approved,
implementing"): `auto` resolves server-side through
`explicit request → per-session → per-agent (account_model_preferences) →
account default → platform default (LLM_GATEWAY_DEFAULT_MODEL)`. This predates
the four-harness ACP work and only ever knew about one thing: "the model
OpenCode's `auto` should resolve to." It is still live today —
`apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx:56-63`
calls `useProjectModels(projectId)` / `useModelDefaults(projectId)` /
`gatewayRoutingPolicyKey(projectId)` on the **same page** as the newer
harness-connection UI, with a comment admitting it was "relocated here from
`gateway-view.tsx`'s tab bar" (models-view.tsx:52-55) — i.e., moved, not
unified. This is a real, observable instance of "two default-model concepts
on one screen" (see Part 2, defect D5).

### 1.2 Harness credential injection (sandbox side)

`apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts` is the
authoritative launch-env compiler, re-run per launch
(`createAcpHarnessRegistry`, harness-registry.ts:524-545, note the comment at
536-538: the registry snapshot is diagnostic only, real launches re-resolve).

- `RuntimeAuthKind` (harness-registry.ts:10-18) is an 8-way enum:
  `managed_gateway | claude_subscription | anthropic_api_key |
  codex_subscription | openai_api_key | openai_compatible |
  anthropic_compatible | native_config`.
- `isolateHarnessAuthEnv` (harness-registry.ts:55-67) **deletes every**
  provider-credential env var (harness-registry.ts:20-32) and re-adds only the
  ones that belong to the session's declared `KORTIX_RUNTIME_AUTH_KIND`. This
  is a real, tested security boundary — an OpenAI key genuinely cannot leak
  into a Claude child process. Pinned by
  `apps/kortix-sandbox-agent-server/src/acp/harness-registry.conformance.test.ts:78-352`.
- `resolveAcpHarnessLaunchEnv` (harness-registry.ts:277-522) is a big per-
  harness switch translating the isolated env into the harness's native
  config shape:
  - **Claude** (line 493-521): direct env passthrough
    (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`) —
    the subscription token is handed **straight to the `claude-agent-acp`
    adapter process**, unmodified.
  - **Codex** (line 349-414): direct API key passthrough OR, for
    `codex_subscription`, **never forwards `CODEX_AUTH_JSON` to the adapter
    at all**. Instead it falls through to
    `DEFAULT_AUTH_REQUEST = { methodId: 'gateway', _meta: { gateway: {
    baseUrl: '${apiUrl}/router/openai', headers: { Authorization: 'Bearer
    ${KORTIX_TOKEN}' } } } }` (harness-registry.ts:398-413) — i.e. the actual
    Codex OAuth/refresh bundle stays **server-side**, and the sandbox process
    talks to Kortix's own `/router/openai` proxy, authenticated with the
    session's own `KORTIX_TOKEN`. The doc comment says exactly this
    (harness-registry.ts:357-360: "CODEX_AUTH_JSON stays server-side where
    the Kortix gateway can refresh it").
  - **OpenCode/Pi**: generate a synthetic provider config
    (`OPENCODE_CONFIG_CONTENT` / `KORTIX_PI_MODELS_JSON`) pointed at whichever
    connection is active — managed gateway, a custom endpoint, or a raw API
    key. Never subscription-only (`claude_subscription`/`codex_subscription`
    are not in either's reachable set — see 1.4).

**This asymmetry matters for Part 3**: Claude's subscription credential is a
real bearer token forwarded verbatim to whatever process holds it — reusing it
outside the official `claude-agent-acp` client would mean handing Anthropic's
own subscription OAuth token to arbitrary other software, a real ToS/security
question, not just a policy toggle. Codex's subscription credential, by
contrast, **never leaves Kortix's own server** — the sandbox process only ever
sees a Kortix-issued bearer token against Kortix's own proxy. Nothing in the
code prevents that same `/router/openai` proxy from being reachable by an
OpenCode or Pi launch config; the restriction to Codex-only is enforced
entirely in `composer-capabilities.ts`'s static table (1.4), not by any
technical wall. Your example ("a Codex subscription could in theory drive
Codex and Pi and OpenCode") is **half right, unevenly**: right for Codex-style
server-proxied subscriptions, not obviously right for Claude-style
direct-token subscriptions without deeper legal/ToS diligence.

### 1.3 Subscription login flows — real, not stubbed

Both exist today, differently shaped:
- **Claude**: `apps/web/.../forms/claude-subscription-form.tsx` — a two-step
  "run `claude setup-token` on your machine, paste the printed token" flow
  (no in-app OAuth; Anthropic's own CLI does the browser round-trip). The
  pasted value is stored as `CLAUDE_CODE_OAUTH_TOKEN` via
  `upsertProjectSecret` (claude-subscription-form.tsx:66-69).
- **Codex**: `apps/web/.../forms/chatgpt-subscription-form.tsx` — a genuine
  server-driven OAuth **device-code** flow:
  `startProjectProviderOAuth(projectId, 'openai', {})` →
  `pollProjectProviderOAuth` loop (chatgpt-subscription-form.tsx:60-105),
  opens the verification URL in a new tab and polls until `success`/
  `failed`/`expired`.

So "subscription logins" are not a gap to build from scratch — Codex's flow
is materially more mature (real OAuth device flow with refresh) than Claude's
(manual CLI-token paste), which is itself a smaller, useful asymmetry to note.

### 1.4 The compatibility matrix already models many-to-many — with two hard exceptions

`packages/shared/src/harnesses.ts:65-114` (`HARNESSES`) is the single source
of truth, mirrored by SDK/sandbox with drift tests
(`packages/shared/README.md:43-66` documents every consumer). Per-harness
`authKinds`:

| harness | authKinds |
|---|---|
| `claude` | `claude_subscription`, `anthropic_api_key`, `native_config` |
| `codex` | `codex_subscription`, `openai_api_key`, `native_config` |
| `opencode` | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` |
| `pi` | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` |

Inverted (`composer-capabilities.ts:83-132`, `CONNECTIONS.<kind>.compatible_harnesses`):
`anthropic_api_key` → `[claude, opencode, pi]` (**already many-to-many**),
`openai_api_key` → `[codex, opencode, pi]` (**already many-to-many**), but
`claude_subscription` → `[claude]` **only**, `codex_subscription` → `[codex]`
**only**. This is explicit, deliberate, and pinned by name:
`composer-capabilities.ts:74-82` "2026-07-15 simplification (founder
decision)" and a named test,
`composer-capabilities.test.ts:150` (`'founder decision 2026-07-15 pins
(WS2-P4-a): claude/codex harness-only, opencode/pi keep the gateway,
anthropic_compatible parked'`), plus `packages/shared/README.md:84-120`.

**So: API keys already satisfy N harnesses. Subscriptions are the one
credential kind still artificially pinned 1:1 — and per 1.2, one of the two
(Codex) has no technical reason for that pin; only policy.**

### 1.5 Model resolution — the full chain

`resolveProjectComposerState` (`composer-capabilities.ts:359-460`) is the one
resolver. Per requested `(agentName, connectionId?)`:
1. Compile `kortix.yaml` → logical agent → `harness` (`compile-runtime-config.ts`).
2. Build `HarnessConnection[]` from project secrets + `llm_gateway` flag +
   native-config file presence (`buildHarnessConnections`, lines 189-215).
3. `resolveActiveHarnessConnection` (lines 226-253): explicit choice → ready
   managed_gateway → exactly-one other ready connection → ready native_config →
   else blocked. **No env-var-order magic** — this part is clean.
4. `modelPresets(active, env, projectId)` (lines 274-306): managed_gateway
   reads `gatewayModelCatalog(projectId)`
   (`apps/api/src/llm-gateway/models/catalog-models.ts:319-328`); API-key
   kinds read the static `models.dev`-derived `CATALOG` capped to 6 newest
   (`NATIVE_MODEL_PRESET_LIMIT`, line 261); **subscription kinds always
   return `[]`** (line 303-305, "Subscription access is owned by the
   authenticated harness. Never fabricate its model list from models.dev.").
5. `computeDefaultAllowed` (lines 321-329) — **the load-bearing function for
   the hang you hit**, see Part 1.6.
6. `can_start = !harnessGated && Boolean(resolved.active) && defaultAllowed`
   (line 455).

Session creation (`apps/api/src/projects/lib/sessions.ts:576-612`) calls this
resolver and **does** enforce it: `!composerCapability.can_start` → HTTP 409
`COMPOSER_CAPABILITY_BLOCKED` (sessions.ts:595-606), before any row is
inserted. `CompiledRuntimeConfig` is always `kind: "acp"` now, for both legacy
v2-compat and v3 manifests (`compile-runtime-config.ts:75,200,227`) — there is
no legacy bypass path that skips this gate. **The gate is real and applies
uniformly.**

### 1.6 Where model resolution legitimately — and illegitimately — returns nothing

Legitimate empty state: a custom endpoint (`openai_compatible`) with no
configured `CUSTOM_LLM_MODEL_ID` and no discovery — `modelPresets` returns
`[]`, `computeDefaultAllowed` returns `false` (not `native_config`, not
`managed_gateway`, `presetsLength === 0`), `can_start = false`, clean 409.
This path is correct.

**Illegitimate empty state (the likely hang root cause, unverified against
your specific repro but fully code-provable):**

```ts
// composer-capabilities.ts:321-329
export function computeDefaultAllowed(input: {...}): boolean {
  if (!input.active) return false;
  if (HARNESSES[input.harness].ownsDefaultModel) return true;
  return input.presetsLength > 0 || input.active === 'native_config' || input.active === 'managed_gateway';
  //                                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //                                          unconditionally true once active === managed_gateway,
  //                                          regardless of presetsLength
}
```

And `connectionConfigured('managed_gateway', …)` (composer-capabilities.ts:172-173)
is simply `return gateway` — the project's `llm_gateway` **experimental flag**
(`projectLlmGatewayEnabled`, `apps/api/src/llm-gateway/enablement.ts:4-6`),
whose platform default is `config.LLM_GATEWAY_DEFAULT_ENABLED`
(`experimental/features.ts:126`) — **a boolean toggle, not a check that any
model is actually reachable behind the gateway.**

Chain: OpenCode is the always-on default harness
(`HARNESSES.opencode.stability === 'stable'`, never gated). If `llm_gateway`
is on for the project (which it is by platform default on a normal deploy) and
no explicit connection is requested, `resolveActiveHarnessConnection` picks
`managed_gateway` as "ready" purely from the flag (step 3 above). `modelPresets`
then calls `gatewayModelCatalog(projectId)` — if that's genuinely empty (fresh
self-host with zero managed provider keys anywhere, or an account with no
managed entitlement and no BYOK connected), `presetsLength === 0`. But
`computeDefaultAllowed` **still returns `true`** because
`active === 'managed_gateway'` short-circuits the check. `can_start` is
`true`. The session is created. The sandbox boots OpenCode pointed at a
`kortix` gateway provider (`session-runtime-env.ts` / `harness-registry.ts:319-337`
`gatewayConfig`) that has nothing to actually serve — and whatever happens at
that point (upstream 4xx swallowed, or a genuinely blocking retry/backoff with
no surfaced ACP error event) is outside this investigation's file set, but is
consistent with "started a session, hung forever" with zero terminal error
shown to the user. **This is a real, named, fixable code defect** — flagging
it, not fixing it, per your instruction that another agent owns the hang.

Related, previously-fixed instance of the same failure *shape*:
`model-defaults-500-no-key-connected.md` (memory) — PR #4866 caught
`GatewayResolutionError` on passive read endpoints so they degrade instead of
500ing. That fix was for reads; `computeDefaultAllowed`'s
`managed_gateway`-always-true branch is the **write-path** analogue and, per
this reading, was never covered by that fix.

### 1.7 UI surfaces

All already route through the same SDK-backed hooks
(`@kortix/sdk/react`: `useModelsPage`, `useHarnessConnections`,
`useComposerModelCatalog`, `useRuntimeAgents`) — genuinely one client-side
model, not per-surface reinvention.

- **Web — Models page**
  (`apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx`):
  a runtime row per harness (`runtime-row.tsx`) + a connection row per auth
  kind (`connection-row.tsx`) + one `Connect` action opening
  `connect-model-modal.tsx`. This is a working implementation of the 2026-07-14
  spec's "one Models page" vision (`2026-07-14-models-page-ui-handoff.md:9-32`).
  It also still carries the legacy gateway default-model widget (`ModelSelector`,
  `useModelDefaults`) inline (models-view.tsx:52-63) — the dual-system seam
  named in 1.1.
- **Web — composer**: `apps/web/src/features/session/harness-model-selector.tsx`,
  `model-connection-gate.tsx`, `use-model-connection-gate.tsx` gate the send
  button on the same `composerCapability` shape.
- **Web — connect flow**: `connect-model-modal.tsx` — method list (Subscriptions
  / API keys & endpoints) filtered by `METHOD_COMPATIBLE_HARNESSES`
  (`harness-method-compat.ts:40-42`, mechanically derived from
  `HARNESSES[id].authKinds`, so it is **automatically consistent** with the
  server table — a real strength, not a duplicated hardcode). Each connect
  form includes a `UseWithRuntimes` checkbox list
  (`forms/use-with-runtimes.tsx:37-71`) letting the user pick which
  *compatible* harnesses adopt this connection as their default in one step —
  this is the UI surface that would light up automatically for
  `codex_subscription`/`claude_subscription` the moment (if) `authKinds` is
  widened; no separate UI work needed for that part.
- **Mobile**: `apps/mobile/components/pages/LlmProvidersPage.tsx` — same SDK
  hooks, own React Native layout, three tabs (`providers`/`connected`/`models`,
  line 77) rather than the web's single scroll — a real, if minor,
  presentation-model divergence between platforms (see D6).
- **Onboarding**: `apps/web/src/components/projects/project-onboarding-wizard.tsx`
  also references model connections (not deep-read in this pass).

---

## Part 2 — Actual design defects (not cosmetic)

**D1 — Subscription credentials are pinned 1:1 to their harness by policy, not
uniformly by necessity.** `codex_subscription`'s `compatible_harnesses` is
`[codex]` even though the credential never leaves Kortix's server and the
sandbox process for *any* harness already talks to `${apiUrl}/router/openai`
with a `KORTIX_TOKEN` bearer for other paths (1.2, 1.4). This is the concrete
instance of "false 1:1 harness↔credential binding" you named, and it's
provably narrower than stated: the same claim does **not** obviously hold for
`claude_subscription`, whose token is forwarded verbatim to whichever process
holds it (1.2) — widening that one is a different, harder (ToS/security)
question than widening Codex's.

**D2 — "Ready" conflates three different things under one boolean.** `ready`
on a `HarnessConnection` (composer-capabilities.ts:31,209-210) is computed
identically to `configured` (line 210: `ready: configured`) and for
`managed_gateway` that's just a feature flag (1.6). "This connection kind is
turned on for this project," "this connection has valid, live credential
material," and "this connection can currently serve at least one model" are
three separate facts collapsed into one field. D1.6's hang is a direct
consequence.

**D3 — `computeDefaultAllowed`'s `managed_gateway` branch trusts availability
it never checks.** Independent of D2's naming problem, the specific line
`input.active === 'managed_gateway'` (composer-capabilities.ts:328)
short-circuits past the `presetsLength > 0` check that every other non-owning
harness is held to. This is the most concrete, fixable defect in the whole
investigation (explicitly not fixing it here per your instruction).

**D4 — The spec that already solved most of this was shipped in a
deliberately narrowed form, and nothing records that the narrowing is
final.** `2026-07-14-provider-auth-model-management.md` §8.1 designs
`ModelConnection` as **multiple named instances per kind** ("More than one
connection of the same type may coexist," line 94) with real IDs/slugs and a
full `/model-connections` CRUD surface (§9, lines 460-469). What shipped is
`composer-capabilities.ts`'s `CONNECTIONS` — a **fixed 8-entry enum, one
per project**, exposed via `/harness-connections` (GET) and
`/harness-connections/{harness}/active` (PUT) only
(`apps/api/src/projects/routes/composer-capabilities.ts:47,126`). There is no
`/model-connections` route anywhere in the tree (verified by grep). Two named
custom endpoints, two Anthropic keys (e.g. personal + org), or "Anthropic prod"
vs "Anthropic staging" are all structurally impossible today — the model *is*
the enum. The models-page-ui-handoff doc's own "Before/After" table promised
"Multiple named custom connections with multiple models" (line 32) as the
target state; it wasn't built. This isn't drift from ignorance — it's an
intentional simplification with no written record of *why* the fuller model
was dropped or whether it's still the goal.

**D5 — Two default-model systems coexist on one screen, unreconciled.**
System B (1.1, gateway `auto` → `account_model_preferences` → platform
default) predates the harness/connection model and still runs on the same
Models page (`models-view.tsx:52-63`) as System A (harness connections). A
user changing "the default model" in one widget has no visible relationship
to the other. This is a second, independent source of "the model selector is
kind of fucked" beyond the subscription-binding complaint.

**D6 — Web and mobile independently re-derive presentation structure.**
Both consume the same SDK hooks (good), but web renders one scrolling page
(runtimes → connections → connect) while mobile renders three tabs
(`providers`/`connected`/`models`, `LlmProvidersPage.tsx:77`) — a second,
independently-maintained information architecture for the same underlying
model. Low severity, but a second place any future model changes must be
re-threaded by hand.

**D7 — `native_config` is the widest-compatible kind (`compatible_harnesses:
[...HARNESS_IDS]`, composer-capabilities.ts:129) yet is presence-detected, not
credential-checked** (`connectionConfigured` line 185: "the profile's
conventional directory owns at least one file"). A harness whose native config
directory contains a non-functional/incomplete file still reads as `ready`.
This is a narrower, lower-severity cousin of D2/D3 — "ready" means "file
exists," not "will actually authenticate."

**D8 — No first-class notion of "credential health decays independently of
whether it's selected."** A Codex refresh token can expire while
`codex_subscription` sits unselected in the connections list; nothing in the
read path (`buildHarnessConnections`) re-validates unselected-but-configured
connections, so the UI can show `Connected` on a connection that would fail
the instant it's activated. (The spec anticipated this — §5.4 "Connection
error behavior," §12.1 "rotate/reconnect" — but the shipped `ready ===
configured` collapse (D2) means there's no live-health signal to hang that UX
on yet.)

---

## Part 3 — Proposed design

The 2026-07-14 spec (`provider-auth-model-management.md`) already answers most
of this well and should not be re-derived from scratch. The real decision is
narrower than "design the system" — it is:

1. Do subscriptions become genuinely many-to-many (fixing D1), and for which
   of the two (Claude vs Codex) is that actually safe?
2. Do we finish the multi-instance `ModelConnection` model the spec already
   designed (fixing D4), or explicitly ratify the singleton-per-kind
   simplification as permanent?
3. How do we collapse `ready`/`configured`/`actually-has-a-model` into
   separate, honestly-named signals (fixing D2/D3), and who is responsible for
   the empty-but-"ready" state?
4. How does the now-explicit "OpenCode default, others behind
   `experimental_harnesses`" decision change what the composer needs to show
   at all?

### Option A — Minimal: fix the false-ready state, leave the credential model as-is

Scope: implement D3's missing check (`managed_gateway` default-allowed only
when `presetsLength > 0` — i.e., actually call `gatewayModelCatalog` before
declaring a default usable), split `ready` into `configured` (secret/flag
present) vs `ready` (secret present **and** a live check or non-empty catalog
succeeded) per D2, and leave the subscription 1:1 pin and the singleton
connection model untouched.

- *Pro*: smallest, fastest, directly kills the hang-class bug and the most
  misleading "Connected" states. Does not touch the founder-decision table, so
  it needs no new product call on subscription reuse.
  *Con*: does not address the credential you actually asked me to investigate
  (D1) or the mess of two default-model systems (D5). Ships something, but not
  "the right way to do it" you asked for.

### Option B — Widen subscription reuse where it's technically sound, keep singleton connections

Scope: Option A, plus:
- Add `opencode`/`pi` to `codex_subscription`'s `authKinds` (D1's provably-safe
  half — the credential already never leaves the server); route it through the
  existing `${apiUrl}/router/openai` proxy path that Codex already uses
  (harness-registry.ts:398-413), generalized to any harness's launch-env
  builder.
- Leave `claude_subscription` pinned to Claude-only pending an explicit
  ToS/security review (flag as **open question**, not silently resolved).
- Keep the singleton-per-kind connection model (do not build `/model-
  connections` CRUD) — ratify D4's simplification in writing instead of
  silently carrying an unbuilt spec forward.
- Split System A/B (D5) by making the harness-connection page the only
  "default model" surface; retire or clearly subordinate the gateway
  account/platform default chain to "what `managed_gateway`'s own Automatic
  mode uses," not a competing concept.

  *Pro*: fixes the two most defensible complaints (D1's Codex half, D2/D3,
  D5) without taking on a data-model migration (new tables, CRUD, multi-
  instance connection IDs) that the 07-14 spec itself estimated as a 12-phase
  program (§13). Ships in weeks, not a quarter.
  *Con*: doesn't solve "two Anthropic keys" / "personal vs org Codex login"
  use cases — those stay impossible. If Marko's actual complaint includes
  wanting multiple named connections (not just wider single-connection reuse),
  this under-delivers.

### Option C — Finish the original spec: multi-instance connections, full CRUD

Scope: build what `provider-auth-model-management.md` §8 and
`models-page-ui-handoff.md`'s "After" column actually promised: named
`ModelConnection` records (`id`, `slug`, multiple per kind), `/model-
connections` CRUD + `/model-connections/:id/test` + `/discover-models`,
`ProjectHarnessRoute` pointing at a connection **id** (not a kind), and widen
subscription reuse per Option B's technical finding as part of the same pass.

  *Pro*: this is the actually-designed target state — nothing new to invent,
  the spec already has the resolution algorithm (§7), the persisted shapes
  (§8), the SDK surface (§9), and a 12-step implementation plan (§13). Solves
  D1, D4, D2/D3, and D5 in one coherent model instead of three patches.
  *Con*: real migration cost — new tables, credential-bundle relocation, a
  breaking change to `project.metadata.harness_auth_routes` (auth-kind string
  → connection id), and it's the scope the spec's own plan sized at ~12
  phases with real E2E matrix requirements (§12). This is the "quarter, not
  weeks" option.

### Recommendation

**Option B now, Option C as the explicit next phase — do not re-litigate the
already-good architecture, and do not let "fix the model selector" quietly
turn into "build multi-tenant connection management" without saying so out
loud.**

Reasoning: the single most urgent thing (the hang, D3) and the single most
defensible complaint you raised (Codex subscription artificially pinned to
Codex-only, D1) are both fixable **without** the data-model migration. Doing
that first buys real, shippable relief and forces the Claude-subscription ToS
question into the open rather than quietly deciding it by silence. The
multi-instance connection model (Option C) is real and worth doing — the spec
already exists — but it is a second, separately-scoped piece of work, and
bundling it into "fix the credential mess" is exactly the kind of scope creep
that produces another half-shipped spec like the current one.

**Sharpest open question you must decide, not me**: is the Claude subscription
token safe/permitted to hand to a non-`claude-agent-acp` process (raw
OpenCode/Pi launch) at all? I did not find an answer in this repo — it is a
product/legal call, not an engineering one, and D1's Codex-safe / Claude-
unsettled asymmetry should not be silently flattened into "just widen both."

---

## Part 4 — Migration path (for whichever option is chosen)

Ordered, flagging breaking changes.

1. **D3 fix (Option A, any path chosen)** — `computeDefaultAllowed`: require
   `presetsLength > 0` for `managed_gateway` too, i.e. drop the
   `|| input.active === 'managed_gateway'` short-circuit and instead let a
   non-empty gateway catalog satisfy `presetsLength > 0` the same way API-key
   presets do. **Non-breaking**: strictly narrows `can_start` from
   sometimes-wrongly-true to correctly-false; the previously-blocked cases
   were already failing, just silently. `harness-capability-conformance.test.ts`
   and `composer-capabilities.test.ts` will need new cases for
   empty-catalog-managed-gateway.
2. **D2 fix** — split `HarnessConnection.ready` into `configured` (secret/flag
   present) and a new explicit `hasModel`/`ready` distinction; **API response
   shape change** — any client reading `ready` as "will start" must be
   re-checked (web/mobile already read `status === 'ready'` in several spots,
   e.g. `connect-model-modal.tsx:187`, `chatgpt-subscription-form.tsx`
   indirectly — needs a full-repo grep before landing, not done in this
   read-only pass).
3. **D1 (Option B)** — widen `HARNESSES.codex.authKinds` is not enough by
   itself; `harness-registry.ts`'s `resolveAcpHarnessLaunchEnv` for
   `opencode`/`pi` needs a new branch that, given `authKind ===
   'codex_subscription'`, builds the same `${apiUrl}/router/openai` +
   `KORTIX_TOKEN` proxy config those harnesses already use for other
   connection kinds. **Breaking for the founder-decision test suite** —
   `composer-capabilities.test.ts:150` and the matching sandbox conformance
   `describe` block both assert the *current* narrow matrix by name; both
   must be deliberately updated, not just left red. `packages/shared/README.md`'s
   "Founder auth decisions (2026-07-15)" section is now stale prose the moment
   this ships — update it in the same change, not after.
4. **D5** — retire or clearly subordinate `useModelDefaults`/
   `gatewayRoutingPolicyKey`'s account/platform default chain from the Models
   page; either fold "Automatic" (managed_gateway's own resolution) into being
   the only remaining consumer of that chain, explicitly labeled as such, or
   remove the standalone widget from `models-view.tsx`. Touches
   `account_model_preferences` semantics — **check any headless/trigger/
   schedule caller that still reads the old chain directly** before removing
   UI for it (not audited in this pass).
5. **Option C, if/when chosen** — follow `provider-auth-model-management.md`
   §11 "Migration" verbatim (it's already written and idempotent): create
   `ModelConnection` rows from today's project-secret bundles, convert
   `CUSTOM_LLM_*` singleton env vars into a `custom-legacy` named connection,
   convert `project.metadata.harness_auth_routes` (**breaking**: auth-kind
   string → concrete connection id) preserving the current valid choice, scope
   old account/project model preferences to the managed route only, and keep a
   compatibility-read window before deleting the singleton `CONNECTIONS`
   table and its routes. This is a `kortix.yaml` **non-breaking** change (the
   spec is explicit, §2 boundary 1-2, that credentials/connections never live
   in `kortix.yaml`) but **is** a breaking change to the `/harness-connections`
   REST/SDK surface, replaced by `/model-connections` + `/harness-routes`
   (§9) — every caller (web, mobile, CLI, Slack, schedules, webhooks) must
   move together, which is why the spec's own plan treats this as one of its
   12 phases rather than an incremental add.

---

## What I did not verify

- The account-level managed-gateway BYOK credential store (separate from
  project secrets) — named in Part 1.1 as adjacent but out of this pass's
  file set.
- The exact in-sandbox behavior when a `kortix` OpenCode provider config
  points at a gateway with no usable model (does it error immediately, retry,
  or truly hang with zero surfaced event?) — Part 1.6's mechanism is fully
  code-traced up to session creation and sandbox launch-config generation; the
  final "why does the UI show an infinite spinner" step is a runtime/ACP-
  bridge behavior this static read cannot confirm. Flagging for whoever owns
  the hang fix.
- Whether Anthropic's Claude Pro/Max subscription OAuth token is technically
  and contractually usable outside the official Claude Code client — this is
  the crux of D1's unresolved half and needs an explicit decision, not code
  archaeology.
- Full-repo grep for every UI/SDK call site reading `HarnessConnection.ready`
  — needed before any D2 field-shape change ships (called out in Part 4 step 2).

---

## Part 5 — Follow-up: where credentials live, the gateway question, and a
##         unified credential service

Scope note: this section is data-model and resolution semantics only, per
instruction — it does not design the connect/model-selection UI (another
agent owns that), and it does not touch `packages/starter/**`,
`apps/api/src/projects/lib/agent-config-v2.ts`,
`apps/web/.../customize/sections/view/runtime-view-model.ts`, or any
session-start/ACP-connect file (other agents are editing those).

### 5.1 Where the bytes actually live — one store for provider material, plus
###     two more that are a different thing entirely

**Direct answer to "is there more than one store for the same logical
thing": no, for provider credentials specifically — there is exactly one
encrypted table. The confusion is real, but its source is that three
*different logical things* (a provider credential, a Kortix-issued gateway
key, and Kortix's own operator-supplied managed keys) sit at adjacent layers
and get called "credentials"/"keys" interchangeably in code and conversation.**

**Store 1 — `project_secrets` (the one table that holds every provider
credential, of every kind).** `apps/api/src/projects/secrets.ts`. AES-256-GCM,
per-project derived key (`projectSecretKey`, secrets.ts:49-61,
`hkdfSync` off `API_KEY_SECRET` + `projectId`). Every row has:
- `scope`: `'runtime'` (reaches the sandbox env) or `'connector'` (never
  reaches the sandbox — secrets.ts:165-166).
- `ownerUserId`: `NULL` = project-shared; a user id = that user's personal
  override of the same `identifier`, which wins over the shared row only
  while `active` (secrets.ts:175-179, 194-231). **This is the whole
  "account vs project vs user, shared vs private" axis** — there is no
  separate account-level table; "account-scoped" here really means
  "personal row on a project."

Confirmed by direct read, both of this investigation's credential kinds
resolve through this **same** table, from **two independent call sites**:
- Harness-auth / composer-capabilities reads it via
  `listProjectSecretsSnapshotForUser` (composer-capabilities.ts:371,411-415)
  to decide what a harness is allowed to launch with.
  API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), the Claude subscription
  token (`CLAUDE_CODE_OAUTH_TOKEN`), and the Codex subscription bundle
  (`CODEX_AUTH_JSON`) are all rows in this one table, distinguished only by
  `name`/`identifier`.
- The canonical `@kortix/llm-gateway` pipeline's own BYOK resolution reads the
  **same** table directly via `getProjectSecretValue`
  (`apps/api/src/llm-gateway/resolution/resolve-candidates.ts:8`, imported
  from `../../projects/secrets`) when a `/v1/llm` request needs a project's
  own provider key. **This is genuine, verified unification at the storage
  layer** — not duplication. Worth stating plainly since most of this
  document is about places that *aren't* unified.

The Codex OAuth bundle gets one piece of special handling on top of the same
table: `apps/api/src/llm-gateway/credentials/codex.ts` reads/decrypts the
`CODEX_AUTH_JSON` row (`loadCodexRow`, codex.ts:29-42, same shared/personal
precedence as everything else), and on `needsRefresh` calls OpenAI's
`/oauth/token`, then **writes the refreshed bundle back into the same
`project_secrets` row** (`refreshAndPersist`, codex.ts:46+, using the same
`encryptProjectSecret`/`decryptProjectSecret` from `projects/secrets.ts`).
There is no separate "OAuth credential" table — refresh is a read-modify-write
on the identical store, gated by an in-memory `inflightRefresh` map to
collapse concurrent refreshes (codex.ts:44).

**Store 2 — `gateway_api_keys` (`gateway-keys.ts`) — not a provider
credential at all.** `kgw_…`-prefixed keys, project-scoped, hashed (not
reversibly encrypted — `hashSecretKey`, gateway-keys.ts:19), for
**programmatic callers authenticating to the Kortix gateway itself**
(`authenticatePrincipal`'s "gateway API key" precedence leg, per the
llm-gateway README's Auth & billing section). This is Kortix issuing a key
*to* a caller, the inverse direction of Store 1 (a caller's key *for*
Anthropic/OpenAI/etc). Naming this ambiguity out loud: a "gateway key" and a
"provider key" are opposite directions of the same word "key," which is
plausibly part of why this "feels layered."

**Store 3 — platform/deployment config, not a database table.**
`config.ANTHROPIC_API_KEY`, `config.OPENAI_API_KEY`, `config.OPENROUTER_API_KEY`,
`config.AWS_BEDROCK_API_KEY` (env vars read via `apps/api/src/config.ts`,
referenced e.g. `descriptors.ts`'s `openRouterManagedDescriptor`/
`bedrockManagedDescriptor`, and `proxy-services.ts:197,208,213-216`'s
`getKortixApiKey()`). These are **Kortix's own operator-supplied keys**
backing every "managed" (Kortix-credit-billed) path — not a project's or
user's credential at all, never encrypted-per-project because they aren't
project data. Distinct from Store 1 only by *whose* key it is, not by
mechanism.

**Net answer to "where do the bytes live, for each kind":**

| Credential kind | Bytes live in | Who can read plaintext | Scope |
|---|---|---|---|
| Plain provider API key (BYOK, e.g. `ANTHROPIC_API_KEY`) | `project_secrets` row | Server-side only (decrypted on read, never returned to any client — secrets.ts has no plaintext-read route to the frontend); the sandbox process it's isolated into | Project-shared or one user's personal override |
| Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`) | `project_secrets` row | Same as above; forwarded **verbatim** into the `claude-agent-acp` process env (harness-registry.ts:495-501) | Project-shared or personal |
| Codex subscription (`CODEX_AUTH_JSON`) | `project_secrets` row, **refreshed in place** by `credentials/codex.ts` | Server-side only — per Part 1.2/1.4, the raw bundle is deliberately never forwarded into the sandbox process at all | Project-shared or personal |
| Kortix gateway key (`kgw_…`) | `gateway_api_keys` row, hashed | Nobody (hash-only; same custody model as a password) | Project |
| Kortix's own managed provider keys | Deployment env config | Operators only; never touches `project_secrets` or any project-facing API response | Platform-wide |

### 5.2 What the gateway actually does today, enumerated

From `apps/api/src/llm-gateway/README.md` plus direct reads:

1. **Auth** — `authenticatePrincipal` resolves `Authorization: Bearer` in
   precedence order gateway API key → legacy YOLO token → account PAT
   (README "Auth & billing"; `hooks.ts`).
2. **Billing/credit metering** — a thrown billing error becomes 402
   `subscription_required` (README); usage is extracted per-request
   (`packages/llm-gateway/src/usage/extract.ts`, confirmed in
   `2026-07-16-gateway-capability-matrix.md` row 23 "Usage/billing accuracy:
   works✓live" across every transport) and recorded via
   `recordGatewayUsage`/`persistGatewayTrace` (`hooks.ts`, README).
3. **Spend caps** — `budgets.ts`: `checkBudget`/`assertGatewayBudget` against
   `gatewayBudgets`/`gatewayRequestLogs` tables, per project and optionally
   per subject-user, `day`/`week`/`month` windows, `warn` (log-only) vs
   `block` (402 `budget_exceeded`) policies (budgets.ts:1-30).
4. **The managed-model offering** — Kortix-credit-billed upstreams: Claude via
   Bedrock (`bedrockManagedDescriptor`, `descriptors.ts`, gated on
   `config.AWS_BEDROCK_API_KEY` + `KORTIX_MANAGED_PROVIDER_ENABLED`
   per its own doc comment) and everything else via OpenRouter
   (`openRouterManagedDescriptor`, `descriptors.ts`, gated on
   `config.OPENROUTER_API_KEY`) — matches the memory note "Gateway managed
   models & upstreams."
5. **The models catalog** — `@kortix/llm-catalog` (`packages/llm-catalog`) is
   the **one shared catalog source**, consumed by both the gateway's own
   resolution (`models/managed-models.ts`, `models/runtime-catalog.ts`,
   `models/picker-catalog.ts` — all `import … from '@kortix/llm-catalog'`)
   and by `composer-capabilities.ts`'s BYOK preset display (`composer-
   capabilities.ts:1`). **This layer is genuinely unified — not a second
   catalog.**
6. **Failover / circuit breaking** — `packages/llm-gateway/src/pipeline/
   failover.ts`, `resilience/circuit-breaker.ts`, `resilience/retry.ts` —
   confirmed live-tested in the capability matrix (row 20/21).
7. **BYOK resolution with managed fallback** — `resolve-candidates.ts`:
   BYOK key hits a limit (429/402/403) → falls over to a managed model when
   the managed gateway + managed provider are both on (resolve-
   candidates.ts:50+ area, "A managed model to fall over to when a BYOK key
   hits a limit").
8. **Request logging / observability** — `gatewayRequestLogs` table (budgets.ts
   imports it for spend calculation; also the trace/usage persistence path
   above).
9. **Key custody for external callers** — `gateway-keys.ts`, Store 2 above.

**This is a real, mature, well-tested control plane** — the capability matrix
doc (`2026-07-16-gateway-capability-matrix.md`) is not marketing; its
`works✓live` cells are backed by actual HTTP calls against Bedrock, OpenAI, and
OpenRouter. None of what follows is a critique of the gateway's engineering
quality — it's about *what traffic actually flows through it*.

### 5.3 The layering that's actually there — three parallel request-routing
###     stacks, not two

This is the concrete answer to "map the layering." There are **three**
independent code paths that can put a model request on the wire, not one
gateway plus "our own provider":

**(A) `@kortix/llm-gateway`** — the modern pipeline described in 5.2, mounted
at `/v1/llm` in-process (`wire.ts:420`) and, on the standalone pod
(`apps/llm-gateway`), also at `/v1/chat/completions`, `/v1/openai/chat/
completions`, and — importantly — `/v1/messages` / `/v1/llm/messages` /
`/v1/openai/messages` (Anthropic-Messages-shaped **ingress**, translated to
the internal OpenAI-chat shape by `packages/llm-gateway/src/ingress/
anthropic-messages.ts`, mounted at `apps/llm-gateway/src/server.ts:233-235`).
This is what OpenCode/Pi's `managed_gateway` connection kind actually calls
(`KORTIX_LLM_BASE_URL`/`KORTIX_LLM_API_KEY`, set in
`apps/api/src/platform/services/session-sandbox.ts:396-401` from the
session's own PAT, gated on `llmGatewayEnabled && gatewayEntitled`).

**(B) `apps/api/src/router` ("kortix-router")** — an older, structurally
separate module (`router.route('/', llm)` + `router.route('/', proxy)`,
`router/index.ts:44-51`), mounted at `/v1/router` (`index.ts:720`), with
**its own, independent billing implementation**
(`router/services/billing.ts`'s `checkCredits`/`deductLLMCredits`,
`router/services/member-spend.ts` — not `llm-gateway/budgets.ts`) and its own
catalog/model-list code (`router/services/llm.ts`'s `proxyToOpenRouter`/
`getModel`/`getAllModels` — not `@kortix/llm-catalog`). Two things share this
mount: a `/chat/completions` OpenAI-shaped proxy-to-OpenRouter endpoint
(`llm.ts`), and a **catch-all direct-passthrough proxy** for
`tavily`/`serper`/`firecrawl`/`replicate`/`context7`/`anthropic`/`openai`/
`xai`/`gemini`/`groq` (`proxy-services.ts`) with three auth modes per request
(`handlers.ts:52-58`): Mode 1 Kortix-owned key (billed 1.2×), Mode 2 the
caller's own key passthrough (billed 0.1×), Mode 3 no Kortix token at all
(pure passthrough, unbilled). This is what Codex's ACP launch is wired to —
`harness-registry.ts:407` sets `baseUrl: '${apiUrl}/router/openai'`.

**(C) Direct-to-provider, in-sandbox, bypassing both (A) and (B).** Whenever a
harness's active connection kind is a plain API key (`anthropic_api_key`,
`openai_api_key`) or `native_config`, `harness-registry.ts` forwards the raw
key straight into the adapter process's env
(Claude: lines 495-501; Codex: lines 368-376) and the harness's own native
provider code calls Anthropic/OpenAI directly. **Per Part 1.4/1.6, this is
already the default behavior for every BYOK connection today** — it is not a
proposal, it already ships.

**A specific, unresolved, flagged discrepancy (marked unverified — needs a
runtime trace, not asserted as fact):** `harness-registry.ts:357-360`'s own
comment states Codex-subscription traffic authenticates "to that [Kortix]
gateway with the sandbox token," implying `CODEX_AUTH_JSON` (refreshed by
Store 1 + `credentials/codex.ts`) is what ultimately serves the request. But
`credentials/codex.ts`'s only importers are `descriptors.ts` and
`resolve-candidates.ts` — both under **stack (A)**, reached via `/v1/llm`, not
`/v1/router`. Stack **(B)**'s handler (`proxy/handlers.ts`,
`proxy-services.ts`), which is what `${apiUrl}/router/openai` actually
mounts to, has **no Codex-specific branch** (grepped `handlers.ts`/
`helpers.ts`/`proxy-services.ts` for `codex` — zero hits outside one comment)
and its only two credential modes are "Kortix's own platform `OPENAI_API_KEY`/
`OPENROUTER_API_KEY`" (Mode 1) or "the caller's passthrough key" (Mode 2) —
neither of which is a per-project refreshed OAuth bundle. **If this reading is
correct, a connected Codex/ChatGPT subscription today may not actually be the
credential that serves the request — it could silently fall back to Kortix's
own managed OpenAI/OpenRouter key and bill Kortix credits instead of using the
user's subscription.** I could not fully confirm or refute this without a live
request trace (out of scope for a static read); flagging it as the single
highest-value thing to verify before touching anything else in this area,
because if true it is a correctness/billing bug independent of any of the
Part 1-4 UX findings.

**A second, narrower flagged inconsistency:** `sandbox-env-sync.ts:192,291`
and `sessions.ts:346` set `KORTIX_OPENCODE_DENY_ENV`
(`nativeProviderEnvNames()`, from `sandbox-credentials.ts`) to strip provider
API keys from "the opencode process" **whenever `llmGatewayEnabled` is true
for the project** — a project-wide, harness-blind toggle. This predates the
per-connection-kind model (its own comment, sandbox-credentials.ts:3-8,
frames it as "these must be withheld… so the gateway is the only LLM path,"
a single-path assumption). Per Part 1.4, a project can simultaneously have
`llm_gateway` on **and** have OpenCode's active connection be
`anthropic_api_key` (BYOK, not managed). Whether `KORTIX_OPENCODE_DENY_ENV`
still fires in that case, and whether it would incorrectly strip the very key
the composer-capabilities layer just decided OpenCode should use, was not
traced to the sandbox daemon's actual env-application code in this pass —
flagged as a second concrete thing to verify, not asserted.

### 5.4 "Should the gateway be made experimental / go direct entirely?" —
###     answered plainly

**Your prior is correct: going fully direct discontinues the managed/credits
offering, it is not an architecture cleanup.** Verified, not assumed — the
managed-model descriptors (`bedrockManagedDescriptor`, `openRouterManagedDescriptor`,
`descriptors.ts`), the budget/spend-cap system (`budgets.ts`), and the
usage-metering/billing hooks (`hooks.ts`, `usage/extract.ts`) only run **inside**
stack (A)'s pipeline (or stack (B)'s separate, cruder billing for its own
scope). A request that goes straight from a harness to `api.anthropic.com`
with a raw key (stack C) is invisible to both — there is no metering hook
anywhere in the direct path by construction (that's the whole point of a
managed credit is being able to bill for it, and nothing bills what it never
sees). So: **"make the gateway experimental, pass keys straight through" is
equivalent to "Kortix no longer sells usage-based managed model access."**
That is a real business call, not an engineering one, and it should be named
as such to whoever makes it — not decided by a code change that quietly
routes around metering.

**The good news: the correct split you proposed as "the likely correct
answer" is already substantially real in the code, for three of four
harnesses.** Per 5.3(C) and Part 1.4/1.6: OpenCode, Pi, Claude Code, and Codex
**all already go direct-to-provider today** the moment their active
connection is a plain API key or native config — no gateway, no `/router`
proxy, nothing metered, by design (that's what BYOK has always meant here).
The gateway (stack A) is mandatory *only* for the one connection kind that
is explicitly Kortix-credit-billed: `managed_gateway`, and per Part 1.4 that
kind is (by the 07-15 founder decision) not even offered to Claude/Codex at
all — only OpenCode/Pi can select it. **The split the product owner is asking
for is not a redesign; it is already the default for BYOK, and the open
question is narrower than "should we build this" — it's "is stack (B)'s
Codex/Claude routing actually correct and metered the way we think it is"
(5.3's flagged discrepancy) and "should Claude/Codex ever get a
`managed_gateway` option at all" (a product call, currently answered 'no' by
the 07-15 decision).**

**Can the gateway serve all four harnesses uniformly today? No — verified by
route inventory, not assumption:**

| Harness's native wire shape | Gateway ingress that speaks it | Where it's mounted |
|---|---|---|
| OpenAI chat-completions (OpenCode/Pi via `@ai-sdk/openai-compatible`) | Yes — the native shape | `/v1/llm/chat/completions` (in-API, `wire.ts:420`) and the standalone pod |
| Anthropic Messages (Claude Code) | Yes — `ingress/anthropic-messages.ts` | **Standalone pod only** (`apps/llm-gateway/src/server.ts:233-235`) — **not mounted in-API** (`wire.ts` mounts only `/v1/llm`, `/internal/gateway`, and a `/v1/llm-gateway/*` reverse proxy to the standalone pod). A self-host/dev deployment running only the in-API path (README: "Serves self-host / dev, and is the fallback when no standalone gateway URL is configured") **has no Anthropic-Messages ingress at all** unless it reverse-proxies to a standalone pod. |
| OpenAI Responses (Codex's native shape) | **No** — grepped the whole gateway tree for a `/v1/responses`-style ingress; none exists. `route-kind.ts`'s `openai-responses` transport (used for genuine-OpenAI reasoning+tools egress, per the capability matrix) is an **egress** transport choice, not an ingress format the gateway accepts from a client. | N/A |

So: for **Claude**, going direct today is partly a real compatibility gap
(the in-API deployment can't speak Claude's native shape at all; only the
standalone pod can), not purely policy. For **Codex**, going direct (or
through stack B) is **entirely** forced by a gap — the gateway cannot ingest
Responses-shaped requests in any deployment mode today.

### 5.5 Recommendation on the gateway question

**Do not make the gateway experimental or optional-by-default. Keep it
mandatory for `managed_gateway` (Kortix-credit) traffic, keep BYOK/subscription
traffic going direct as it mostly already does, and treat "route more harness
traffic through the real gateway" as a compatibility-completion project, not a
bypass decision.** Concretely:

1. Ratify in writing (this is the actual decision the owner needs to make,
   not an engineering one) that `managed_gateway` remains the only
   Kortix-credit-billed path, and that BYOK/subscription connections are
   direct-to-provider by design — which is already true for 3 of 4 harnesses'
   BYOK legs today, so this is mostly documentation, not a rewrite.
2. Resolve 5.3's flagged Codex-subscription discrepancy first — it is
   higher severity than anything else in this document if confirmed true
   (silent credit billing instead of using a paid personal subscription).
3. If Claude/Codex subscriptions should ever be offered a `managed_gateway`
   option (reopening the 07-15 decision, separate from this question), that
   requires mounting the Anthropic-Messages ingress in-API (not just the
   standalone pod) and building an OpenAI-Responses ingress that doesn't
   exist yet — real, scoped engineering work, not a config flip.
4. Do **not** route BYOK traffic through the gateway "for observability" —
   that reintroduces exactly the metering/custody question in reverse (now
   the gateway sees a user's own key) for a benefit (spend caps, catalog
   consistency, model allowlists) that only matters for Kortix-billed usage.
   BYOK spend is the user's own provider bill, already visible to them at the
   source — the loss from going direct for BYOK (no Kortix-side observability
   of BYOK spend, no Kortix-enforced allowlist on BYOK) is a real trade-off
   but consistent with what BYOK has always meant everywhere else in this
   industry, and is a legitimate call the owner can make either way, not a
   correctness gap.

### 5.6 A unified credential service — how much already exists

**Most of the hard part already exists. This is not a greenfield design.**
Build on, don't replace:

- **Storage**: `project_secrets` (5.1, Store 1) already IS the one store for
  all three credential kinds (API key, Claude subscription, Codex
  subscription), already has shared-vs-personal scoping, already has
  encryption at rest, and — for Codex — already has refresh-on-read wired up.
  **New work needed**: nothing structural. What's missing is purely at the
  read side (5.7 below): a typed `CredentialKind` discriminator instead of
  inferring kind from `name`/`identifier` string matching, and a `status`
  field computed once (not re-derived ad hoc by every caller) so "expired,"
  "needs refresh," and "healthy" are queryable without re-running
  `credentials/codex.ts`'s refresh logic inline.
- **Capability/compatibility matrix (credential kind → harnesses it can
  satisfy)**: already exists and is already many-to-many for API keys —
  `packages/shared/src/harnesses.ts`'s `HARNESSES[id].authKinds`, inverted by
  `composer-capabilities.ts`'s `CONNECTIONS.<kind>.compatible_harnesses`
  (Part 1.4). **New work needed**: widen it per Part 3's Option B/D1 finding
  (Codex subscription's compatible-harness set is a policy choice, not a
  technical wall) — this is a data-table edit plus updating the two pinned
  tests that assert the current narrow matrix, not new infrastructure.
- **Credential kind → models it unlocks**: already exists —
  `composer-capabilities.ts`'s `modelPresets()` (Part 1.5, step 4). **New
  work needed**: fix D3 (5.4/Part 2) so an unlockable-but-empty managed-gateway
  catalog doesn't read as "unlocks a default model."
- **Rotation/revocation**: `upsertProjectSecret`/`deleteProjectSecret` already
  exist as SDK-level operations (used by every connect form in Part 1.7).
  **New work needed**: a live health-check ("test connection") distinct from
  "a row exists," which Part 2's D8 already named as missing — the 07-14 spec
  designed this (`POST /model-connections/:id/test`, §9) and it was one of
  the pieces not built (Part 2 D4).
- **Expiry/refresh for OAuth subscriptions**: exists for Codex
  (`credentials/codex.ts`, real refresh-token flow). **Missing for Claude** —
  Claude's flow is a one-time manual token paste (Part 1.3) with no refresh
  path visible in this codebase; Anthropic setup-tokens have their own
  external expiry behavior this investigation did not verify. **Flag as
  unverified**: whether `claude setup-token`-issued tokens expire/refresh at
  all, and if so whether anything here would notice — this is exactly the
  D8 gap (a credential can silently go stale between "connected" and "used").
- **Sandbox receives only the filtered subset it needs**: already exists and
  is a genuine strength — `isolateHarnessAuthEnv` (harness-registry.ts:55-67)
  deletes every provider-credential env var and re-admits only the active
  kind's, per harness process, tested by name
  (`harness-registry.conformance.test.ts:78-352`). **New work needed**: none,
  modulo resolving 5.3's second flagged discrepancy (`KORTIX_OPENCODE_DENY_ENV`
  vs. per-connection-kind isolation potentially disagreeing).

**What's genuinely new, if a "unified credential service" is built as its own
deliverable rather than as incremental fixes to the existing store:** only
the multi-instance `ModelConnection` model from Part 2's D4/Part 3's Option C
— named, multiple-per-kind records with stable ids instead of the current
singleton-per-kind rows keyed by a fixed `name`. Everything else asked for in
this question (single store, three credential kinds, compatibility matrix,
encryption, scoping, rotation, sandbox filtering) is not a redesign — it is
the current `project_secrets` + `composer-capabilities.ts` pair, made
explicit and given a name.

### 5.7 The resolution function, precisely

This is the function the composer/model-selection UI (owned elsewhere) must
be able to call and render every branch of. It formalizes what
`resolveProjectComposerState`/`state.capabilities()` (composer-
capabilities.ts:359-460) already computes today, with the D2/D3 fixes from
Part 2 folded in (i.e. this is the *corrected* semantics, not a re-statement
of the current buggy `computeDefaultAllowed`):

```ts
type CredentialStatus =
  | 'absent'            // no row for this kind at all
  | 'invalid'           // present but fails a live check (bad key, revoked)
  | 'expired'           // present, was valid, has a known expiry that passed
                         // and could not be silently refreshed
  | 'healthy';          // present and currently usable

type ModelAvailability =
  | { kind: 'harness_default' }        // owning harness supplies its own
                                        // default; no catalog needed (Part 1.5)
  | { kind: 'catalog'; models: ConnectionModel[] } // non-empty, real choices
  | { kind: 'empty' };                 // credential healthy, zero models —
                                        // must block, never silently pass

type ResolvedHarnessOptions =
  | { state: 'no_compatible_credential' }
    // harness has zero credentials of any kind on file for its authKinds
  | { state: 'credential_expired'; credentialId: string }
    // the resolved/selected credential's status is 'expired' or 'invalid'
  | { state: 'credential_healthy_no_models'; credentialId: string }
    // status healthy, ModelAvailability.kind === 'empty' — THE Part 1.6/2 D3 bug,
    // must be a distinct, named state so it can never silently read as startable
  | { state: 'ready'; credentialId: string; availability: ModelAvailability };

function resolveHarnessModelOptions(
  agentName: string,
  harness: HarnessId,
  explicitCredentialId?: string,
): ResolvedHarnessOptions {
  // 1. compatible = every credential on file whose kind is in
  //    HARNESSES[harness].authKinds (Part 1.4's already-many-to-many table)
  // 2. if compatible.length === 0 → 'no_compatible_credential'
  // 3. selected = explicitCredentialId ?? project-default-for-harness ??
  //    (exactly one ready managed/BYOK candidate) ?? native_config fallback
  //    — same precedence as resolveActiveHarnessConnection (Part 1.5 step 3),
  //    unchanged
  // 4. if selected.status !== 'healthy' → 'credential_expired'
  // 5. availability = harness.ownsDefaultModel ? {kind:'harness_default'}
  //      : computeModelAvailability(selected)  // the FIXED version of
  //        Part 2 D3 — for managed_gateway this MUST check the live catalog,
  //        never short-circuit on the connection kind alone
  // 6. if availability.kind === 'empty' → 'credential_healthy_no_models'
  // 7. else → 'ready'
}
```

**Degraded states the UI must be able to represent** (this is the exhaustive
set implied by the function above, stated explicitly per the instruction):

1. **No compatible credential at all** — harness selected, zero credentials
   of any authKind on file. UI action: "Connect …" (already how
   `connect-model-modal.tsx` behaves today for an unconfigured method).
2. **Credential present but expired/invalid** — distinguish from #1: the UI
   knows *which* credential and can offer reconnect/rotate rather than a
   blind "connect" (already designed in the 07-14 spec §5.4, not fully
   backed by a live status field today — Part 2 D8).
3. **Credential healthy, zero models** — must be a **blocking**, named state,
   never conflated with "ready" (this is the direct fix for the hang in
   Part 1.6/2 D3). For a harness with `ownsDefaultModel: true` this state is
   unreachable by construction (step 5 never calls `computeModelAvailability`
   for those harnesses) — it can only happen for OpenCode/Pi on a connection
   kind that isn't `native_config`/subscription, i.e. exactly the
   `managed_gateway`-with-empty-catalog case identified in Part 1.6.
4. **Ready with a harness-owned default** — Claude/Codex/Pi's normal case,
   no model picker needed at all (Part 1.5's existing, correct behavior).
5. **Ready with a real catalog** — OpenCode/Pi via managed gateway (non-empty)
   or a BYOK/custom endpoint with discovered/preset models.

This function is intentionally the same shape as today's
`ComposerCapabilities.capabilities()` return — the fix is narrowing what
counts as `can_start`/`ready`, not replacing the resolver. Whoever builds the
D2/D3 fix from Part 2 should implement exactly this state machine so the UI
agent has a fixed, named set of states to design against rather than a single
boolean.

### 5.8 What I did not verify (additions to Part 1's list)

- Whether Codex-subscription ACP traffic is actually served by the refreshed
  `CODEX_AUTH_JSON` bundle or silently falls back to Kortix's own managed
  OpenAI/OpenRouter key via stack (B)'s Mode 1 — 5.3's flagged discrepancy,
  the single highest-priority thing to confirm with a live request trace.
- Whether `KORTIX_OPENCODE_DENY_ENV` (project-wide, gateway-flag-driven) can
  strip a BYOK key out from under a harness whose composer-capabilities-
  resolved connection kind is that same BYOK key — needs a read of the
  sandbox daemon's env-application order, not done in this pass.
- Whether Anthropic setup-tokens (Claude subscription) expire/refresh at all,
  and whether anything in this codebase would notice if one did.
- Whether the standalone gateway pod's `/v1/messages` ingress is actually
  reachable from a live sandbox process today (i.e. whether `apiUrl`/
  `KORTIX_LLM_BASE_URL` for any current connection kind ever points at it) or
  is mounted but unused by any harness currently — this document only
  confirmed it *exists* and *where*, not that anything calls it yet.
