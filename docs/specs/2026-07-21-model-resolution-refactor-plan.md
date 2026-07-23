# Model and provider management — from-first-principles reimplementation spec

Status: proposed, for owner decision before execution starts
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510 (Claude Code, Codex, OpenCode, Pi)
Author: Claude (planning agent), for Marko

Mandate (owner, verbatim): *"Thermonuclear refactor — from first principles,
just re-implement the entire model and provider management. Instead of
patching all of this, we should remove, remove, remove, and re-implement from
scratch."* This document designs the system as if it did not exist yet, then
maps every existing file onto that design. Anything that doesn't map is the
delete-list. The six specs written today
(`2026-07-21-llm-credential-and-model-management.md`,
`2026-07-21-credential-and-model-selection-ux.md`,
`2026-07-21-gateway-universal-transport-plan.md`,
`2026-07-21-codex-billing-leak-verification.md`,
`2026-07-21-claude-subscription-parity.md`,
`2026-07-21-zed-acp-ux-comparison.md`) are the factual baseline — every claim
about current code below was independently re-verified against the live
worktree in this pass, not copied. Where this document corrects one of them,
the correction is stated.

A same-day commit (`56b607706`, "stop the infinite Connecting hang on a
no-model session") already patched one instance of the exact bug class this
document exists to make structurally impossible. It is a real improvement and
it is also proof the patch cycle doesn't converge — its own fix (§4, item 12)
is a second, better-aimed patch, not a design. That is the owner's point, and
this document does not repeat the mistake by proposing a third patch.

---

## 0. The one-sentence diagnosis

**Today, five different pieces of code each compute their own answer to "can
this session run, with what model, who pays" — a project-secrets flag check,
a hand-authored compatibility table, a raw catalog dump, a client-side
re-verification, and a boolean-reconciliation wrapper — and none of them is
the other's source of truth. The fix is not to make the five agree. The fix
is to have one.**

---

## 1. First principles — the four concepts, designed with no reference to existing code

Before mapping anything, name what this system fundamentally has to represent.
Four concepts. Not five, not eleven — every one of the eleven-plus things
enumerated in §4 either becomes one of these four or has no place in the
design and dies.

### 1.1 Credential

A piece of proof, held by a project (optionally scoped to one user within
it), that some request can be authenticated as some provider or subscription.
A credential has:
- a **kind** (what shape of proof it is — an API key, an OAuth bundle, a
  bearer token, a config-file directory),
- a **scope** (shared across the project, or one user's personal override),
- a **health** (currently usable, currently invalid, currently expired —
  computed by actually checking, not inferred from "a row exists"),
- exactly one **custody rule**, decided once, per kind, never per instance:
  can this credential's proof ever be used by a process Kortix operates on
  the credential owner's behalf, or must it only ever be handed to the
  owner's own already-running process. This is not a policy toggle a project
  can set — it is a fact about the credential kind itself (§2.3).

Nothing about a credential mentions a harness. A credential is a fact about
auth, full stop.

### 1.2 Capability matrix

A static, platform-declared table answering exactly one question: **given a
credential kind, which harnesses can run on it, and what does running on it
cost.** This table is authored **once**, in **one direction**. Every other
shape anyone needs (which credential kinds a given harness accepts; which
harnesses light up when a credential connects) is a pure function *of* that
one authored direction, never a second hand-maintained table. This table
does not change per project — it is the same for every project on the
platform, which is exactly why it belongs in a dependency-free shared
package, not a database row.

### 1.3 Catalog

The live, refreshed set of providers and models that exist in the world,
with their capabilities and pricing — a fact about the world (what OpenAI,
Anthropic, etc. currently publish), not a fact about any project or
credential. A catalog entry existing says nothing about whether any given
project can reach it — that's concept 1.4.

### 1.4 Availability resolution

Given a project, a harness, and (optionally) an explicit credential choice:
**the one function** that combines 1.1 (is there a healthy credential), 1.2
(is that credential's kind compatible with this harness, and what does it
cost), and 1.3 (conditioned by 1.1, what can actually be reached) into a
single, closed answer. The answer is a **state**, not a boolean plus a
separately-computed list that might disagree with the boolean. A state
design where "empty list but startable" cannot be constructed in the type
system is a design requirement, not a nice-to-have — see §3.3.

**A fifth thing exists and is legitimately separate, not a fifth concept
merged into the four above: default-model preference.** "What does an unset
model resolve to" is a preference chain (session > agent > account >
platform), meaningful **only** for harnesses whose availability resolution
(1.4) produces a browsable catalog — a harness that owns its own default
(Claude/Codex/Pi today) has no "unset" state for Kortix to have an opinion
about, by construction. This is not a fifth first-class concept; it is a
narrow, optional refinement of 1.4's catalog-shaped answer, scoped to
exactly the harnesses where it can mean anything.

**Routing rules (per-request fallback chains, a forced vision-model override,
"if this model rate-limits, try that one") are explicitly not a first-
principles concept this document redesigns.** They answer "once a request is
already going out, which upstream handles it," a request-time question,
entirely downstream of and orthogonal to "can this session start at all."
Verified as a genuinely separate concern by reading both resolvers in the
current code (§4) — kept, not touched, not one of the four.

That's the whole model: **Credential × Capability matrix × Catalog →
Availability resolution**, plus one narrow, conditionally-applicable
preference chain for the one harness-shape where "default" is meaningful.
Everything in the current codebase that isn't naming one of these four
things, or isn't a pure derivation of one of them, has no place in this
design.

---

## 2. Ownership — where each concept lives, and why

The owner's framing: *"decide whether it's part of the gateway... it should
be part of the gateway."* Answered directly, concept by concept, with
reasoning, not a single yes/no:

| Concept | Owner | Why |
|---|---|---|
| **Catalog** (1.3) | `@kortix/llm-catalog` (existing shared package) | Already correct today — a dependency-free, models.dev-derived package consumed by both the gateway and the API. No change; a browser/RN-safe catalog cannot be gateway-request-scoped code. |
| **Capability matrix** (1.2) | `packages/shared/src/harnesses.ts` (existing shared package) — **as the sole authored direction** | This table is a fact about *harnesses* (an ACP/session-runtime concept the gateway has no reason to know exists — the gateway serves LLM requests, it does not know what an "ACP harness" is). It must stay outside the gateway for the same reason the catalog does: browser/RN-safe, dependency-free, the single source every surface (web, mobile, CLI, sandbox) reads directly with zero network round-trip. **The inverse direction (credential kind → harnesses, `compatible_harnesses`) is deleted as an authored table and becomes a pure function over `HARNESSES[*].authKinds`** (§4, kill item 2) — one authored fact, one owner, the inverse is arithmetic, not data entry. |
| **Credential health + resolution** (1.1's "is this actually usable right now") | **The gateway** (`apps/api/src/llm-gateway/credentials/**`) | This is the owner's "it should be part of the gateway" call, and it is the correct one: the gateway already owns the only real implementation of "resolve a stored credential into something that can serve a request" (`resolveCodexCredential`, refresh-on-read, `billingMode` assignment) for one credential kind. Extending that ownership to *every* credential kind (Claude, plain API keys) rather than leaving it split between `composer-capabilities.ts`'s presence-only checks (`connectionConfigured`) and the gateway's own `resolve-candidates.ts` removes exactly the "same fact computed twice, once shallow, once real" duplication this document is required to kill. **Storage stays where it is** (`apps/api/src/projects/secrets.ts` — `project_secrets` is a generic encrypted KV store also used for non-model secrets, e.g. connector credentials; moving storage itself into the gateway package would wrongly couple an unrelated secret-storage concern to LLM-specific code). The gateway owns *resolving* a stored row into a health/billing/custody fact; it does not own *storing* the row. |
| **Availability resolution** (1.4, "the one function") | **The gateway** (`apps/api/src/llm-gateway/resolution/`, new module, sibling to `resolve-candidates.ts`) | It is pure composition of three gateway-owned or gateway-adjacent facts (credential health, capability matrix, catalog) plus one caller-supplied parameter it must never look up itself: the calling harness's compatible auth kinds (supplied by the ACP/session layer from the shared capability matrix, §1.2). The gateway does not need to know what a "harness" is to answer "given these acceptable credential kinds, what's available" — parameterizing it this way is what keeps the gateway harness-agnostic (it already serves non-ACP callers: headless API, CLI) while still being the single owner of the answer. |
| **Default-model preference chain** | **The gateway** (`llm-gateway/resolution/effective.ts`, existing) | Already correctly owned there. Its only defect today is a **second UI control** on the Models page pointed at the same store (§4, kill item 8) — the store and its resolver are not duplicated, only its UI surface is. Kept, UI-relocated. |
| **Routing rules** | **The gateway** (`llm-gateway/routing/**`, existing) | Already correctly owned there, a genuinely separate concept (§1.4), untouched by this plan. |
| **Harness identity, session/sandbox mechanics, ACP launch-env translation** | **The API's projects/ACP layer** (`apps/api/src/projects/lib/**`, `apps/kortix-sandbox-agent-server/src/acp/**`) | This is the one thing that must **not** move into the gateway: which named agent maps to which harness, how a session is provisioned, how a resolved credential becomes the specific env vars/config a sandboxed adapter process needs. The gateway has no business knowing what a sandbox is. This layer's only job with respect to the four concepts above is to **call** the gateway's resolution function with the right parameters and **translate** its answer into (a) an ACP launch env and (b) an API response shape — never to recompute any part of the answer itself. |

**One owner per concept, stated as an invariant, not a preference**: nothing
outside `llm-gateway/resolution/` may compute a credential's health, a
credential's billing mode, or whether a catalog entry is reachable. Nothing
outside `packages/shared/src/harnesses.ts` may declare which credential
kinds a harness accepts. Nothing outside `llm-catalog` may declare what
models exist. A file that needs one of these facts imports the owner's
answer; it does not re-derive it, however small the re-derivation looks in
the moment (this is precisely how `CatalogSelector`'s five-line "just check
the flag too" grew into the empty-catalog bug, §5).

### 2.3 The Claude exception — a first-class field, not a patch

Per `2026-07-21-claude-subscription-parity.md` §2 (Anthropic's own written
policy, quoted verbatim there, fetched primary-source): a third party may
never route a request through a Free/Pro/Max-plan credential on the user's
behalf, regardless of which downstream process ends up consuming it. This is
not a per-request runtime decision — it is a permanent fact about the
`claude_subscription` credential kind, so it is represented as one:

```ts
type CredentialCustody = 'direct-only' | 'relay-eligible';

const CREDENTIAL_CUSTODY: Record<HarnessAuthKind, CredentialCustody> = {
  claude_subscription: 'direct-only',   // hardcoded, never derived, never
                                         // overridden per-project — this is
                                         // the exception, stated once
  codex_subscription: 'relay-eligible', // per the parity doc's own finding:
                                         // the credential never leaves
                                         // Kortix's server today by
                                         // construction (harness-registry.ts
                                         // never forwards CODEX_AUTH_JSON to
                                         // the sandbox) — verified safe
  anthropic_api_key: 'relay-eligible',
  openai_api_key: 'relay-eligible',
  openai_compatible: 'relay-eligible',
  anthropic_compatible: 'relay-eligible',
  managed_gateway: 'relay-eligible',    // it IS the relay
  native_config: 'direct-only',         // by definition — a committed
                                         // config file, never a Kortix-held
                                         // secret to relay in the first place
};
```

**Enforcement, not convention**: the gateway's credential-resolution module
(§2, row 3) refuses — throws, does not silently degrade — to build any
descriptor that would place a `direct-only` credential's raw material behind
a Kortix-operated endpoint (a `/router/*` or `/v1/llm/*` request handler).
This is the same shape of guarantee the transport-plan spec already
identified for Codex's `billingMode: 'none'` (§2.4 of that document: "the
function that resolves a credential into an `UpstreamDescriptor` is the only
place `billingMode` is set... there is no code path where a `codex/*`
request successfully resolves to a Kortix-managed descriptor") — this
document extends that same structural guarantee one field wider, to custody,
so a future engineer cannot accidentally build a `claudeDescriptor` that
relays the token the way `codexDescriptor` correctly does *not* relay
`CODEX_AUTH_JSON`'s raw bundle but *does* forward a resolved access token
server-side (which is fine, because Codex is `relay-eligible`) — the two
credential kinds must not be handled by the same code path without this
field forcing the branch.

---

## 3. Behavior contracts

### 3.1 The moment a user selects a harness/agent in the composer

One sequence, stated precisely, replacing every ad hoc fetch/compute path
that exists today:

1. **Fetch**: the client calls exactly one endpoint —
   `GET /projects/:id/composer-capabilities?agent_name=<agent>` — which
   internally calls the gateway's resolution function (§1.4) with the
   compiled agent's harness and its `HARNESSES[harness].authKinds`. No
   second request for "is the gateway flag on," no second request for
   "what secrets exist," no client-side re-derivation of either. **This is
   the whole fetch.** (`GET /projects/:id/model-catalog` remains a separate
   endpoint only because a browsable catalog can be large and some callers
   — the composer picker specifically — want it lazily, not because it is a
   second computation; it calls the identical resolution function and
   returns its `availability.models` field verbatim.)
2. **Compute**: nothing, client-side, about availability. The client's only
   job is to render the returned `state` (§3.3) and, for `state: 'ready'`,
   the returned `availability.kind`. Every existing client-side "is this
   connected" recomputation (§5, item 5) is deleted, not rewritten — there
   is nothing left for it to compute once the server's answer is trusted.
3. **Render, exactly one of five ways**, driven by `state`:
   - `no_credential` → the model-pill slot renders as a direct `Connect
     <Harness>` action, not a picker (already the UX spec's §3.3
     recommendation; this document makes it the *only* reachable rendering
     for this state, not one of several plausible ones).
   - `expired` → `Reconnect <Harness>` action, naming the specific
     credential.
   - `healthy_but_no_models` → a picker that opens to an explicit empty
     state with a `Manage`/`Connect a model service` action — never a
     silently-empty popover, never a send button that lets the turn through.
   - `ready` + `availability.kind === 'harness_default'` → an `Auto` row,
     no browsable list, optional free-text override (Claude/Codex/Pi's
     shape today, unchanged).
   - `ready` + `availability.kind === 'catalog'` → a browsable, already-
     filtered list (OpenCode's shape today; Pi's shape once §5.1's dangling
     `ownsDefaultModel` question is resolved).
4. **Gate send**, at the server, off the identical `state` (`can_start =
   state === 'ready'`) — the client's send-button disable is a rendering of
   that boolean, never an independent check.

### 3.2 What "models available" means — one definition, three named variations

**Definition: a harness has available models for a project iff its
resolved credential (per §1.4) is `healthy` and the catalog conditioned by
that credential (per §1.1 × §1.3) is non-empty, OR the harness declares
`ownsDefaultModel: true`, in which case "available" means the credential
alone being `healthy` — there is no catalog to be non-empty, by
construction.** One sentence, two clauses joined by the harness's own
declared shape. Named variations, not separate definitions:

- **Catalog-driven** (`ownsDefaultModel: false` — OpenCode today):
  "available" = a real, non-empty, credential-conditioned list exists.
  Zero credential-reachable entries is `healthy_but_no_models`, not `ready`
  with an empty array — the type system does not allow constructing
  `{state:'ready', availability:{kind:'catalog', models:[]}}` (§3.3).
- **Harness-owned** (`ownsDefaultModel: true` — Claude/Codex/Pi today):
  "available" = the credential is healthy, full stop. No catalog is ever
  consulted, requested, or displayed as a list — this is not "a catalog
  that happens to have one entry," it is structurally a different shape
  (`{kind:'harness_default'}`, no `models` field to be empty or not).
- **Subscription-backed** (a further-narrowed harness-owned case — Claude
  and Codex subscriptions specifically): identical availability semantics to
  harness-owned, distinguished *only* by `billingMode: 'none'` and, for
  Claude, `custody: 'direct-only'` (§2.3) — never by a different
  availability computation. A subscription is not a special case of
  "available"; it is a special case of *who pays* and *who may touch the
  token*, layered on top of the same harness-owned shape.

### 3.3 Model identity, end to end — one grammar, one exception, one transform seam

Today: the string a user picks in the composer, the string the gateway
resolves against its catalog, and the string a harness process actually
receives are three loosely-related vocabularies (a `provider/model` catalog
key; a `kortix/<slug>` gateway-prefixed wire id; a bare native model id
passed as `ANTHROPIC_MODEL`/`CODEX_CONFIG`). This document collapses them to
one:

**Canonical grammar, used everywhere a model is named — the composer, every
API response, the resolution function's `availability.models[].id`, the
gateway's own internal resolution — with exactly one synthetic sentinel and
one namespaced exception, both already real and both kept:**

```
{provider}/{model}          — the general case (e.g. anthropic/claude-...)
kortix/auto                 — the one synthetic sentinel: "the gateway decides"
codex/{model}                — ChatGPT-subscription-backed models, namespaced
                                under their own synthetic provider (already
                                shipped, catalog-models.ts's CODEX_PROVIDER_ID)
```

**There is exactly one seam where this grammar is transformed, and it is
declared, not inferred**: `HARNESSES[harness].modelNamespacing:
'gateway-prefixed' | 'bare'` (already a real field, `harnesses.ts:50`)
governs whether the harness-registry launch-env builder keeps the
`{provider}/` prefix or strips it when writing the harness's actual runtime
config (`ANTHROPIC_MODEL`, `CODEX_CONFIG`, OpenCode's provider JSON). This
is the **only** place identity changes shape, and it changes shape for
exactly one reason (some harness-native config formats don't accept a
namespaced id) — never as an incidental side effect of which endpoint served
the string. A model id a user picks in the composer, a model id the
resolution function returns, and a model id logged in a trace/usage record
are always byte-identical; only the final write into a launch env applies
the one declared strip/keep transform.

---

## 4. Mapping the current codebase onto the design — the kill list

For each of §1's four concepts (plus the one narrow preference-chain
refinement), what currently exists maps cleanly, partially, or not at all.
**Not-at-all is the kill list.** Every kill states what it is, how its
absence of other consumers was verified, and what (if anything) survives in
its place per §2's ownership table.

### 4.1 Concept 1.1 (Credential) — maps cleanly, one extension needed

`project_secrets` (`apps/api/src/projects/secrets.ts`) already is exactly
concept 1.1's storage: kind-agnostic, scope-aware (shared/personal),
encrypted. **No kill here.** What's missing is the *resolution* half
(health, not just presence) for every kind except Codex
(`llm-gateway/credentials/codex.ts` is the only real implementation of
"resolve a stored credential into a health/billing fact" — confirmed by
grep, zero equivalent for Claude, zero for plain API keys beyond a
`Boolean(env.X?.trim())` presence check). **Extend, do not replace**: build
`credentials/claude.ts` (mirroring `codex.ts`'s shape, no refresh call per
the parity doc's own finding that no refresh mechanism is known to exist for
a `claude setup-token` bearer) and a generic `credentials/api-key.ts` (a
lightweight liveness check for plain provider keys — today's presence-only
check is the actual gap, not the storage).

### 4.2 Concept 1.2 (Capability matrix) — one authored table survives, one duplicate dies

**Kill: `composer-capabilities.ts`'s `CONNECTIONS` table's
`compatible_harnesses` field as hand-authored data**
(`apps/api/src/projects/lib/composer-capabilities.ts:84-133`). Verified this
is a duplicate, not an independent fact: cross-checked every entry against
`packages/shared/src/harnesses.ts:65-114`'s `authKinds` by hand — all eight
entries are exact inverses of the harness table today (`managed_gateway` →
`[opencode, pi]` matches exactly the two harnesses whose `authKinds`
includes `managed_gateway`; `claude_subscription` → `[claude]` matches
exactly; all eight checked, all consistent). Two hand-maintained arrays that
must always agree are one authored fact wearing two costumes — the moment
they're edited independently (exactly the scenario D1/Option B in the
credential-mgmt doc describes: widening `codex_subscription`'s reach) is the
moment they can silently drift. **Replace with a pure function**,
`compatibleHarnessesFor(kind: HarnessAuthKind): HarnessId[]`, computed once
from `HARNESSES`, colocated in `packages/shared` (zero I/O, testable with a
single round-trip assertion: "every harness's declared `authKinds` list
appears in this function's inverse for that kind, and vice versa" — a test
that is currently impossible to write meaningfully because there are two
independent sources to compare instead of one source and its derivation).
`label`/`source` (the two other fields `CONNECTIONS` carries per kind) are
not compatibility data — they stay authored, once, wherever the derived
function lives.

**Kill: `connectionConfigured`'s `managed_gateway` branch as an
availability/readiness signal** (`composer-capabilities.ts:172-174`:
`case 'managed_gateway': return gateway` — `gateway` is
`projectLlmGatewayEnabled(metadata)`, a raw feature flag). This is D2/D3 from
the architecture doc, restated precisely for the kill list: a feature flag
is not a credential health check, and `connectionConfigured` returning
`true` for `managed_gateway` off the flag alone is exactly the
"configured/ready/has-a-model" conflation this whole document exists to
undo. **The flag still matters** (it gates whether the managed route is
offered *at all* for this project) but it stops being treated as a
*readiness* answer — it becomes one input to the gateway-owned resolution
function (§1.4), which is the only place allowed to say `ready`.

### 4.3 Concept 1.3 (Catalog) — maps cleanly, one misuse dies

`@kortix/llm-catalog` and `runtimeModelCatalog` (`llm-gateway/models/*`) are
already the single, live, correctly-owned catalog. **No kill to the catalog
itself.** The kill is one specific *use* of it as an availability signal:

**Kill: `gatewayModelsAll()`/`gatewayModelCatalog(projectId)` as a
human-facing "what can this project use" answer**
(`apps/api/src/llm-gateway/models/catalog-models.ts:227-256, 319-328`).
Read directly: `gatewayModelCatalog` returns the **entire** theoretical
catalog gated only by `Boolean(projectId)` — not by any credential the
project actually holds (line 319-328: `return projectId ? catalogs.full :
MANAGED_ONLY`). **Verified it has two legitimate, surviving,
non-human-facing consumers, both unconditioned on purpose and correctly
so**: `internal-routes.ts:113` and `snapshots/build-context.ts`, both of
which build the sandbox's own multi-provider config — a process that
legitimately needs to know the full theoretical shape of every provider it
*might* be told to use, independent of what any one project has connected.
**Verified the one illegitimate consumer**: `modelPresets`'s `managed_gateway`
branch in `composer-capabilities.ts:276-282` calls this function directly
where a credential-conditioned answer already exists and is already used
correctly one route over (`r4.ts:2211-2259`'s `/model-picker`,
`projectPickerCatalog` wrapper, conditioned on `secrets.names` and
`requiredModels`). **This single call site is the entire root cause of "Pi
shows 4,941 models"** (§5). Kill this one call site; the function and its
two legitimate consumers survive untouched.

### 4.4 Concept 1.4 (Availability resolution) — everything computing it today dies, replaced by one new module

This is where the aggressive-deletion standard bites hardest, because five
separate pieces of code today each partially compute this concept, and the
new design has exactly one function computing it (§1.4, §2 row 4, §3.3's
state shape):

1. **Kill: `computeDefaultAllowed`** (`composer-capabilities.ts:322-330`).
   Its own doc comment already half-admits the problem it causes
   (`managed_gateway` short-circuits past the presets check every other
   non-owning harness is held to). Superseded entirely by the new
   resolution function's closed state union — there is no `default_allowed`
   boolean anymore, only a `state`.
2. **Kill: `managedGatewayHasNothingToRouteTo`**
   (`composer-capabilities.ts:359-374`, added by `56b607706` today). Its own
   doc comment names exactly what it is: a heuristic patch for the gap item
   1 leaves open. Its escape hatch (§ old finding, still true after this
   morning's fix: "assume the gateway has something to route to if *any*
   other compatible connection is ready," never verifying that assumption
   against the actual conditioned catalog) is precisely the "wrapper that
   exists only to reconcile two signals" the mandate asks to be named and
   killed. Once the catalog is genuinely credential-conditioned (§4.3's
   kill), a non-empty conditioned catalog **is** proof of reachability —
   this function's entire reason to exist disappears; it is not "fixed
   again," it is deleted.
3. **Kill: `usableDefault = defaultAllowed && !noManagedRoute`**
   (`composer-capabilities.ts:490`) and the surrounding reconciliation
   plumbing (`noManagedRoute`, the two-signal `blockingReason` fork at lines
   492-499). **This is exhibit A for the mandate's "prefer designs where
   whole categories of conditionals disappear because the state model makes
   them unrepresentable."** Under the new closed `state` union (§3.3), there
   is no second boolean to AND against — a value of type
   `HarnessModelResolution` is *already* exactly one of the four states;
   code that computes two independent opinions and then reconciles them
   with `&&` cannot be written against this type, because there is only one
   field to read.
4. **Kill: `CatalogSelector`'s independent client-side visibility gate**
   (`apps/web/src/features/session/model-selector.tsx:222-262` —
   `useProjectLlmGatewayEnabled`, the redundant `listProjectSecrets` refetch,
   `connectedGatewayProviderIdsFromSecretNames`, and the resulting
   `connectedProviderIds` filter inside `useModelStore`). Verified as the
   direct cause of the "OpenCode: No models available" half of the reported
   repro (§5). **Verified no other consumer of the deleted call site's
   output needs it**: `connectedProviderIds` is constructed and consumed
   entirely within this one component's render — it is not exported, not
   passed to a sibling, not read by any test outside
   `model-selector.test.tsx` (grepped `connectedProviderIds` — zero hits
   outside this file and its own test). Once the server serves an
   already-conditioned list, this component's job shrinks to "render what
   you were given," matching what `HarnessSelector` already correctly does
   today with no equivalent gate.
5. **Kill: `composer-chat-input.tsx:214`'s hardcoded `nativeHarness =
   harness !== 'opencode' ? harness : null`.** Not a computation of
   availability itself, but the un-declared routing logic that decides
   *which* of two now-dead-and-replaced computations (item 4's
   `CatalogSelector` gate, or the harness-mode path) a given harness's
   result flows through. Replaced by branching on the resolution function's
   own `availability.kind`, which is the fact this string comparison was
   trying to approximate all along.

**What survives, and where it lives now**: exactly one function,
`resolveHarnessModels` (§1.4, §3.3), in `apps/api/src/llm-gateway/resolution/`
(new module). It absorbs the *correct* parts of items 1-3 above (the
harness-owns-its-default short-circuit from `computeDefaultAllowed`'s first
line survives as §3.2's harness-owned branch; the precedence logic in
`resolveActiveHarnessConnection`, verified correct and unchanged by every
prior spec's reading, survives as this function's credential-selection step)
— nothing about *what* the system decides is being thrown away, only the
*number of places* deciding it.

### 4.5 The preference-chain refinement — one store survives, one duplicate control dies

**Kill: the Models page's standalone `Default model` panel**
(`apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx:52-63,117-141`
— `useModelDefaults`/`useProjectModels`/`gatewayRoutingPolicyKey` wiring and
render block, verified still present by direct read, not assumed from the
UX spec's unexecuted recommendation). **Survives, unchanged: the underlying
store and resolver** (`account_model_preferences`,
`llm-gateway/resolution/effective.ts`) — this is concept 1.4's narrow
preference-chain refinement's real backing store, correctly gateway-owned
already (§2). The kill is the *second UI control* pointed at the same store
with no visible link to the per-runtime row three inches below it (D5). Per
§2's ownership table, its one remaining UI surface is relocated into the
`Kortix` connection's own manage modal — the one place a gateway-central
world has exactly one home for "my default model," per the UX spec's §8.3.

### 4.6 Two presumptive kills investigated and explicitly rejected

The escalated mandate names three "default-model stores" as presumptive
kills. Two of the three were investigated and are kept, with reasoning, not
silently carried over from the original brief's framing:

- **`account_model_preferences` — kept.** It is not a duplicate of anything;
  it is concept 1.4's own narrow preference-chain refinement's real store,
  correctly scoped (only meaningful for catalog-driven harnesses, per §3.2),
  correctly gateway-owned (§2). What dies is its second UI surface (§4.5),
  not the store or its resolver.
- **`project_routing_policies` — kept.** Verified by reading both resolvers
  directly: `llm-gateway/resolution/effective.ts` (consumes
  `account_model_preferences`, answers "what does an unset model resolve
  to") and `llm-gateway/routing/resolve-route.ts` (consumes
  `project_routing_policies`, answers "given a chosen model, what fallback/
  vision-override/routing rule applies to this specific request") are two
  different functions answering two different questions about two different
  moments (session-default-selection vs. per-request-routing). Conflating
  them would be adding a fifth first-principles concept back in disguise,
  not simplifying. Its own UI (`gateway-routing.tsx`) is untouched by this
  plan.
- **The Models-page project-default *UI panel* (not a store) — killed**,
  per §4.5. This is the one piece of the "three stores" framing that was
  actually a duplicate, and it is the one duplicate control, not a
  duplicate store.

### 4.7 A fifth kill category the mandate names explicitly: the old router's LLM lanes

**Presumptive kill, not yet executable — flagged, not scheduled in this
plan's Phase 1-4 (§7), because it is already fully scoped by a sibling
document.** `apps/api/src/router`'s LLM-shaped lanes
(`router/routes/llm.ts`'s `/chat/completions`, and the `openai`/`anthropic`/
`xai`/`gemini`/`groq` lanes of `router/config/proxy-services.ts`'s generic
proxy) are a second, independent billing/catalog implementation
(`router/services/billing.ts`, `router/config/models.ts`) for a question
concept 1.4's resolution function is now the sole owner of. **Not killed by
this document's Phase 1-4** because `2026-07-21-gateway-universal-transport-plan.md`
§3 already fully specs its consolidation (which lanes move to the modern
gateway, which stay for non-LLM tool-API proxying, in what order, gated on
building the still-missing Responses-shaped ingress first) — re-planning it
here would be exactly the "two documents disagreeing about the same thing"
failure mode this plan is trying to eliminate elsewhere. **This document's
only addition**: name it explicitly on the kill list (the mandate requires
this), and note the one dependency this plan's Phase 4 already carries
forward — the Codex billing-leak fix (§7, step 4.1) is the one piece of that
larger consolidation pulled into this plan's critical path, because it is a
live, confirmed, billing-correctness bug, not a duplication-cleanup.

---

## 5. The Pi-vs-OpenCode divergence, explained precisely

**Both harnesses get the identical, correct answer from the current backend.
The divergence is entirely in two different frontend components independently
deciding whether to trust it — concept 1.4 computed once correctly, then
recomputed twice more, disagreeing both times.**

Trace, with the exact resolved state for the reported repro (one project,
three credentials: `ANTHROPIC_API_KEY`, `CODEX_AUTH_JSON`,
`CLAUDE_CODE_OAUTH_TOKEN`, all `scope=runtime`, `active`, shared):

1. **Backend resolution is identical for both harnesses today, and it is not
   where the two visible symptoms diverge.** `HARNESSES.opencode.authKinds`
   and `HARNESSES.pi.authKinds` are byte-identical (`harnesses.ts:99,111`).
   `resolveActiveHarnessConnection` prefers a ready `managed_gateway`
   connection over every BYOK connection unconditionally
   (`composer-capabilities.ts:241-245`). With the project's `llm_gateway`
   flag on (the platform default), **both OpenCode and Pi resolve
   `active: 'managed_gateway'`**, regardless of the three BYOK/subscription
   credentials on file, and both then call the identical
   `modelPresets('managed_gateway', ...)` → the identical, unconditioned
   ~4,900-entry array (§4.3's kill target). Confirmed by reading
   `composer-chat-input.tsx:226,376`: `capabilityModels` (fed to OpenCode)
   and `capability.data?.model.presets` (fed to Pi) are the **same query
   result**, read at two lines of the same file.
2. **The divergence starts at `composer-chat-input.tsx:214`**
   (§4.4, kill item 5): a hardcoded `!== 'opencode'` string comparison, not
   a lookup against any declared property, routes Pi through
   `HarnessSelector` and OpenCode through `CatalogSelector`.
3. **`HarnessSelector` (`model-selector.tsx:679-875`) renders its `presets`
   prop with no credential filtering** — only a UI cap and search. Fed the
   ~4,900-entry unconditioned array, it renders (capped, but still) all of
   it. The component is not wrong given its input; its input is wrong
   (§4.3's kill).
4. **`CatalogSelector` (`model-selector.tsx:185-671`) does not trust its
   `models` prop's presence at all** — it re-derives its own, second,
   independent availability signal (§4.4, kill item 4):
   `useProjectLlmGatewayEnabled` + a redundant client-side
   `listProjectSecrets` refetch → `connectedGatewayProviderIdsFromSecretNames`
   → `useModelStore.isVisible`. Without an active search query, every model
   whose provider isn't in this independently-computed set is filtered out
   of the default view. If this component's own flag read or its own
   secrets refetch disagrees with the server's already-resolved answer —
   timing, a different flag reading, or the provider-recognition function
   simply not matching the three connected credentials — the entire list
   renders as zero, exactly the reported "OpenCode: No models available."
5. **Neither component is answering the question the product needs.**
   `HarnessSelector` answers "show me whatever preset array I was handed"
   (correct component behavior, wrong input, per the killed unconditioned
   catalog). `CatalogSelector` answers "is this provider connected, by my
   own independent read" (a real computation, duplicating and diverging from
   the server's). **Once §4.4's kill list is executed and the resolution
   function is the only place computing this, both symptoms disappear for
   the same reason**: there is nothing left to disagree with, because there
   is nothing left recomputing the answer a second or third time.

---

## 6. The narrowing decision

**Recommendation: yes, unconditionally, for every human-facing surface —
already argued in the original brief, restated here because it is now a
structural property of the design, not a policy choice layered on top of
it.** Under §3.3's closed state union, `{state:'ready',
availability:{kind:'catalog', models:[]}}` is not merely discouraged — the
type has no room for it; an empty catalog is `healthy_but_no_models`, a
different state entirely, by construction.

**What a user loses, stated exactly**: nothing they could ever actually use.
The unconditioned catalog (§4.3's kill target) was never reachable — no
request could succeed against a `models.dev` entry the project holds no
credential for — it was only *visible*, and only in the one component that
doesn't re-verify its input. Narrowing removes zero real capability. The one
thing it removes is passive discoverability of "what I could connect to
unlock" inside the composer's picker — already correctly served by the
connect-modal's method list (`connect-model-modal.tsx`), which exists
specifically to answer that question and should be the only place that does.

**Per harness**: Claude/Codex (`ownsDefaultModel: true`, no catalog ever
shown) are unaffected. OpenCode is unaffected in shape — it already narrows
correctly via `/model-picker`'s existing conditioning; this plan makes the
composer's path use the same conditioning, not a stricter one. **Pi is the
one harness whose correct treatment is genuinely undecided** — flagged as an
open question, not resolved here (§8, risk item).

---

## 7. Consumer migration

- **Composer** (`ComposerModelControls`/`ModelSelector`) — after §4.4's
  kills, both `HarnessSelector` and `CatalogSelector` render exactly what
  they're given; the only remaining client-side logic is which of the two
  to mount, driven by `availability.kind` from the server, not a harness-name
  string comparison.
- **Session-start gate** (`sessions.ts:576-612`) — reads `state === 'ready'`
  directly from the resolution function's response; no separate
  `can_start` boolean to drift from the state enum, no
  `managedGatewayHasNothingToRouteTo` heuristic left to call.
- **ACP bootstrap timeout** (`packages/sdk/src/acp/session.ts`, added by
  `56b607706`) — kept as a defensive backstop for failure modes genuinely
  outside this document's scope (sandbox provisioning, network partitions),
  not as the primary correctness mechanism.
- **CLI** (`apps/cli/src/command-helpers.ts:382-392`) — already reads the
  same `/composer-capabilities` route's structured response; gains the new
  `state` field additively, `can_start` stays present through the migration
  window (§8, Phase 0).
- **Mobile** (`LlmProvidersPage.tsx:96-100`) — replace the hand-written
  3-value `connectionStatus()` with a shared status-label helper consuming
  the same `state` union, so a fifth state added later cannot silently
  degrade to "Not connected" on mobile the way a truly independent switch
  statement would.
- **Models page** — the `Default model` panel deleted, its control
  relocated into the `Kortix` connection's manage modal (§4.5); runtime rows
  (`runtime-row.tsx`/`connection-row.tsx`) need no structural change, only
  the copy for `healthy_but_no_models` as a real, distinguishable state
  instead of a generic "needs attention."

---

## 8. Sequenced plan

A from-scratch reimplementation still ships as independently-safe steps on a
live product. **Step 0 freezes the new interface in place, additive and
unreachable, before any deletion begins — the strangler pattern.** Every
step after Step 0 is either "point one more consumer at the frozen
interface" or "now that nothing reads the old path, delete it" — never both
in the same step, so nothing is ever mid-flight between two sources of
truth.

### Step 0 — freeze the interface (blocks everything else, touches nothing live)

- **Changes**: create `apps/api/src/llm-gateway/resolution/harness-models.ts`
  exporting `resolveHarnessModels` with the exact signature and state union
  from §3.3, plus `packages/shared/src/harnesses.ts`'s new
  `compatibleHarnessesFor(kind)` pure function (§4.2). **Initially, this
  function may internally delegate to today's logic verbatim** (call
  existing `resolveActiveHarnessConnection` + the *not-yet-deleted*
  `computeDefaultAllowed`/`managedGatewayHasNothingToRouteTo`, wrapped to
  produce the new closed-state shape) — correctness of the internals is not
  required on day one, only that the **shape** is frozen and nothing outside
  this module constructs a `HarnessModelResolution` value any other way.
  Real internals (§4.3/§4.4's actual fixes) land in Step 1, behind the
  already-frozen signature.
- **Deletes**: nothing. Purely additive; unreachable from any consumer until
  Step 1 wires the first caller.
- **Tests**: unit tests on the new module's shape only — every state
  constructible, every state's fields present, `compatibleHarnessesFor`'s
  round-trip test against `HARNESSES` (§4.2).
- **Risk**: none — dead code until Step 1.
- **Revertible**: trivially, delete the new file.
- **Owns**: two new files only, zero edits to existing files. Fully
  parallelizable with anything else in this plan (nothing depends on it
  being merged first except Step 1 itself).

### Phase 1 — make the frozen interface's internals correct (depends on Step 0, blocks Phase 2)

**Step 1.1 — Credential-condition the catalog inside the resolution
function.** Changes: `resolution/harness-models.ts`'s internals only, using
the existing `projectPickerCatalog`-style conditioning (extracted into a
shared helper so `r4.ts:2252-2256` and this module call one function, not
two). Deletes: the module's internal use of raw
`gatewayModelCatalog(projectId)` for anything human-facing (§4.3's kill,
executed here). Tests: bounded-count assertions per §old-draft's original
Step 1.1 (a single-credential project's conditioned list must be small, not
~4,900). Risk: low — strictly narrows an already-unreachable-in-practice
list. Owns: `resolution/harness-models.ts`,
`llm-gateway/models/catalog-models.ts` (extracting the shared conditioning
helper) — coordinate with whoever else touches `catalog-models.ts` this
week.

**Step 1.2 — Replace the delegated boolean logic with real state
computation.** Changes: `resolution/harness-models.ts`'s internals stop
calling `computeDefaultAllowed`/`managedGatewayHasNothingToRouteTo` and
compute the four-state union directly per §3.3, using Step 1.1's
conditioned catalog as the `healthy_but_no_models` vs `ready` discriminator.
Deletes: the module's dependency on the two old functions (the old functions
themselves are not deleted from `composer-capabilities.ts` yet — nothing
outside the new module reads them yet either; they become dead code,
removed in Phase 3 once verified unreferenced). Tests: one case per state ×
per harness kind (`ownsDefaultModel` true/false) × per credential-health
value. Risk: medium — this is the real logic change; ship behind the full
existing composer-capabilities test suite passing, not a flag (pure-function
correctness, not a product-behavior flag decision). Owns: same file as 1.1,
sequential with it, not parallel.

### Phase 2 — point consumers at the frozen interface (depends on Phase 1, parallelizable within itself by file)

**Step 2.1 — `composer-capabilities.ts`'s route handlers call the new
module instead of their own inline logic.** Changes:
`apps/api/src/projects/lib/composer-capabilities.ts`'s
`resolveProjectComposerState(...).capabilities()` closure now calls
`resolveHarnessModels` and maps its result onto the existing
`ComposerCapabilities` response shape (additive `state` field alongside the
existing `can_start`/`auth`/`model` fields, so CLI/mobile/web don't have to
move in lockstep — §7's Phase-0-style additive-field discipline, kept from
the original brief). Deletes: nothing yet (the old inline functions become
provably dead in this step, deleted in Phase 3). Tests: existing
`composer-capabilities.test.ts`/`harness-capability-conformance.test.ts`
suites must pass unchanged (response shape is additive) plus new assertions
that the new `state` field matches the old `can_start` boolean's truth value
exactly, for every existing test case — a mechanical proof the migration is
lossless before anything old is removed. Risk: low (additive). Owns:
`composer-capabilities.ts` only.

**Step 2.2 — Delete `CatalogSelector`'s independent visibility gate.**
Changes: `apps/web/src/features/session/model-selector.tsx:222-262`
(§4.4 kill item 4). Depends on 2.1 having shipped and the API's `state`
field being trustworthy. Tests: per the original brief's Step 2.1 (a
non-empty `models` prop always renders visibly; the empty state only fires
from an empty prop). Risk: medium — user-visible; verify against the
already-running dev stack (read-only observation, do not mutate) before
merging. Owns: `model-selector.tsx` only — parallelizable with 2.3 (no file
overlap).

**Step 2.3 — Delete the hardcoded `nativeHarness` string-fork.** Changes:
`composer-chat-input.tsx:214,357,366-381` — branch on `availability.kind`
from the new `state` field instead of `harness !== 'opencode'`. Tests: per
the original brief's Step 2.2. Risk: low. Owns: `composer-chat-input.tsx`
only — parallelizable with 2.2.

### Phase 3 — delete everything now provably dead (depends on Phase 2 merged, not just opened)

**Step 3.1 — Delete `computeDefaultAllowed`, `managedGatewayHasNothingToRouteTo`,
the `usableDefault`/`noManagedRoute` reconciliation plumbing, and
`connectionConfigured`'s flag-as-readiness branch's role as an availability
signal** (§4.4's kills 1-3, §4.2's kill). **Verification required before
deleting, not assumed**: grep every one of these four names across the full
repo (`apps/api`, `apps/web`, `apps/cli`, `packages/sdk`, test files) and
confirm zero remaining callers outside `composer-capabilities.ts` itself and
its own test file — Phase 2 should have made this true, but verify, don't
assume. Tests: delete the now-orphaned unit tests for the killed functions
themselves; keep every test that was asserting *behavior* (those should
already have an equivalent in `resolution/harness-models.ts`'s Phase 1 test
suite — if not, that's a coverage gap to close before deleting, not after).
Risk: low (nothing should reference these by the time this step runs) but
**do not skip the grep** — this is exactly the kind of step where "surely
nothing else calls it" is the failure mode this document's own §0 exists to
prevent. Owns: `composer-capabilities.ts`.

**Step 3.2 — `CONNECTIONS`'s hand-authored `compatible_harnesses` →
derived function.** Per §4.2. Changes:
`packages/shared/src/harnesses.ts` (add `compatibleHarnessesFor`),
`composer-capabilities.ts`'s `CONNECTIONS` table (delete the
`compatible_harnesses` field per entry, call the derived function instead).
Tests: the round-trip assertion from Step 0. Risk: low, mechanical. Owns:
both files — small enough to be one step, not split.

**Step 3.3 — Remove the Models page's `Default model` panel, relocate its
control.** Per §4.5. **Before this ships**: grep every caller of
`account_model_preferences`'s write path outside `models-view.tsx` and the
new relocation target (`manage-connection-modal.tsx`) — **unverified in
this pass, required before this step ships**, per both prior specs' own
flag that headless/trigger/schedule callers were never audited. Owns:
`models-view.tsx`, `manage-connection-modal.tsx` — parallelizable with 3.1
and 3.2 (no file overlap).

### Phase 4 — the two live-correctness gaps pulled forward from sibling documents (parallelizable with each other and with Phase 3, depends only on Step 0)

**Step 4.1 — Codex billing-leak fix**, per
`2026-07-21-codex-billing-leak-verification.md`'s own minimal-fix section
verbatim — not re-planned here. **New finding this pass surfaces, unverified,
flagged for whoever executes this step**: the UX spec's §1.1 found a
`/router/codex-subscription` route with fail-closed behavior already exists
on this branch (`apps/api/src/router/routes/proxy/codex-subscription.ts`),
postdating the verification doc. Check whether this route already closes the
leak before re-implementing anything — **unverified whether it's the same
fix or a still-needed second one**, check first. Owns:
`apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`'s `codex`
branch.

**Step 4.2 — Claude credential module (Tier A only, per
`2026-07-21-claude-subscription-parity.md` §4 items 1-5)**, feeding §4.1
of this document's credential-resolution extension. No relay, no
`compatible_harnesses` widening — policy-blocked per §2's Claude exception,
enforced structurally by §2.3's `CREDENTIAL_CUSTODY` table, not left to a
future engineer's judgment. Owns: new file
`apps/api/src/llm-gateway/credentials/claude.ts` — depends on Step 0's
module existing as the place this credential's health feeds into, not on
Phase 1-3 landing first (additive, can run in parallel with Phase 2/3).

**Step 4.3 — Mobile status-vocabulary unification** (§7). Owns:
`LlmProvidersPage.tsx`, a new shared status-label helper in
`packages/sdk/src/react/`. Lowest priority, fully independent.

### Ordering summary

Step 0 first, alone. Phase 1 next, alone (both steps touch the same new
file, sequential). Phase 2's three steps parallelize by file once Phase 1 is
merged. Phase 3 starts only after Phase 2 is merged (not opened) — its
grep-and-verify steps require Phase 2's consumers to actually be live.
Phase 4 is independent of Phases 1-3 past Step 0 and can run the entire time
in parallel, on entirely disjoint files.

---

## 9. Risks and honest costs

- **This is a bigger blast radius than the original patch-shaped plan.**
  Moving credential-resolution ownership into the gateway (§2) touches a
  file (`composer-capabilities.ts`) that at least one other agent on this
  branch edited today (`56b607706`). **Coordinate before Phase 1 starts** —
  this is not a file two agents can safely touch concurrently without a
  merge conflict on the exact lines this plan needs to delete.
- **Product-visible narrowing** (§6) — unchanged from the original brief's
  finding, restated: the composer's model list shrinks for any project
  currently seeing the unconditioned catalog. Call this out in release
  notes explicitly.
- **Ownership migration itself is a cost, not free.** Moving
  credential-resolution logic from `apps/api/src/projects/lib` into
  `apps/api/src/llm-gateway` is a real code-move, not a relabeling — every
  import path changes, and the two modules currently have different test
  harnesses/fixtures. Budget for this explicitly in Phase 1; it is not a
  "just rename the folder" step.
- **The Pi `ownsDefaultModel` question (§6) blocks Phase 2 for Pi
  specifically, not for OpenCode/Claude/Codex.** `harnesses.ts` declares
  `pi.ownsDefaultModel: true`, but Pi's actual launch-env code
  (`harness-registry.ts`'s `id === 'pi'` branch, per the transport-plan
  spec's Correction B) builds a full gateway-catalog-shaped config, the same
  shape as OpenCode's — not a harness-native default the way Claude/Codex
  genuinely work. This is a real, pre-existing inconsistency between the
  declared capability table and actual launch behavior, not introduced by
  this plan. **Owner or whoever owns `harnesses.ts`/`harness-registry.ts`
  must resolve this before Phase 2 ships Pi's rendering path specifically**
  — every other harness's Phase 2 work is unblocked by this question.
- **`account_model_preferences`/`project_routing_policies` stay
  unaudited for headless callers** (§4.6) — Phase 3's UI relocation does not
  itself audit every trigger/schedule/webhook caller of the preference
  chain's write path. **Owner sign-off needed**: is "UI-only relocation,
  write-path unaudited" an acceptable ship condition for Step 3.3, or does
  that audit need to happen first.
- **The old router's LLM lanes (§4.7) are named on the kill list but not
  scheduled in this plan's four phases** — they remain live, billing
  Kortix-credit traffic through a second, unconsolidated code path, until
  the transport-plan spec's own sequencing executes. This plan does not
  make that gap worse, but it also does not close it beyond the one Codex
  leak fix pulled into Phase 4.
- **Claude/Codex subscription widening (D1) stays explicitly out of
  scope**, structurally enforced by §2.3's custody table rather than left as
  an open policy question a future patch could silently resolve wrong.
  Codex widening remains a legitimate, separately-schedulable product
  decision (technically safe per the credential-mgmt doc); Claude widening
  is not a decision to be made, it is foreclosed by Anthropic's own written
  policy (§2.3) — this plan treats those as two different kinds of "no,"
  and encodes only the second one as unconditional.

---

## 10. Explicitly out of scope

- Gateway-as-universal-transport for all four harnesses' live request
  traffic (separate, larger, already speced in
  `gateway-universal-transport-plan.md`) — this document only moves
  *resolution/availability* ownership into the gateway, not request-time
  transport for Claude/Codex/Pi. Conflating the two would be exactly the
  scope creep the original credential-mgmt doc warned against.
- Consolidating the old router's LLM lanes (§4.7) beyond the one Codex
  billing-leak fix — scheduled by its own sibling document, not re-planned
  or re-sequenced here.
- Multi-instance `ModelConnection` records / `/model-connections` CRUD
  (Option C of the credential-mgmt doc's Part 3).
- Moving `project_secrets` *storage* itself into the gateway package (§2) —
  storage stays generic and API-owned; only resolution moves.
- Widening `claude_subscription`'s `compatible_harnesses` — foreclosed by
  policy, not merely deferred (§2.3, §9).
- Widening `codex_subscription`'s `compatible_harnesses` — technically
  available, deliberately not scheduled by this plan; a separate product
  decision.
- Mobile's full information-architecture redesign (3-tab → 2-section) —
  only the status-vocabulary unification (Step 4.3) is in scope.
- Pattern-based tool-permission rules, the single-agent composer pill's
  static-vs-interactive rendering — real, adjacent, unrelated to model
  resolution (per the Zed comparison spec).
- Anthropic Consumer ToS contract-language legal review — this plan treats
  the parity doc's primary-source policy-page finding as sufficient to
  enforce the custody exception in code; it does not itself constitute
  legal sign-off.
