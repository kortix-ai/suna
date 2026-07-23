# Credential and model selection UX

Status: proposed, ready for review
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510 (Claude Code, Codex, OpenCode, Pi)
Author: Claude (UX spec agent), for Marko

Method: read-only investigation of the live implementation (`apps/web`,
`apps/mobile`, `apps/api`, `packages/shared`, `packages/sdk`) plus the four
prior specs in this scope. No code was changed to produce this document. Every
claim about current behavior is grounded at `file:line`. Anything not directly
observed is marked **unverified**.

This document supersedes nothing — it is additive UX guidance on top of
`2026-07-14-provider-auth-model-management.md` (the still-valid product
decision) and takes `2026-07-21-llm-credential-and-model-management.md` (the
architecture investigation, hereafter "the architecture doc") as its factual
baseline for backend behavior. Where this document repeats a defect the
architecture doc already named (D1–D8), it cites the same label and adds only
UX-surface detail; it does not re-derive the backend analysis.

**Headline finding, stated up front because it changes the shape of the
work**: this is not a greenfield problem. Roughly three-quarters of what the
owner asked for is already built, including a second-generation "unified
model picker" that already does harness-first, one-control model selection —
it just ships **off by default** behind an experimental flag nobody has
turned on project-wide. The actual gap is narrower and sharper than "design
the credential/model UX": it is (1) one small but structural server-side
truth-value bug that makes the good client-side gating architecture lie, (2)
a leftover duplicate "default model" control that contradicts the
runtime-row model directly below it, (3) promoting/finishing the picker
that already exists instead of designing a new one, and (4) closing a
presentation gap on mobile. Section 1 below is deliberately harsh about
which 25% is actually broken, because burying it under praise for the 75%
that works would be exactly the vague criticism the brief asked me not to
produce.

---

## 1. Current-state critique

### 1.1 What is already good (do not redesign this)

- **The Models page** (`apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx`)
  is a faithful, working build of the 2026-07-14 handoff spec: one page,
  "Agent runtimes" rows above "Your connections" rows, `Change`/`Connect`
  inline per runtime (`runtime-row.tsx:82-93`), `Manage` per connection
  (`connection-row.tsx:94-103`). This is the right shape and should not be
  rebuilt.
- **The connect flow already derives compatibility mechanically from the
  same table the server uses** — `METHOD_COMPATIBLE_HARNESSES`
  (`harness-method-compat.ts:40-42`) is `HARNESS_IDS.filter(id =>
  HARNESSES[id].authKinds.includes(kind))`, read straight off
  `packages/shared/src/harnesses.ts`. If a credential's compatible-harness set
  ever widens (the architecture doc's D1/Option B), every UI surface that
  reads this table updates with **zero UI code changes**. This already
  satisfies the brief's "never duplicate one credential three times" — the
  data model is many-to-many-native; only today's data (two hard-pinned
  subscription rows) is narrow, and that narrowness is honestly reflected,
  not concealed.
- **Subscription harnesses already have correct, spec-compliant model UX.**
  `HarnessModelSelector` (`apps/web/src/features/session/harness-model-selector.tsx`)
  renders "Models managed by Claude Code" / "…Codex" copy
  (`harness-model-selector-helpers.ts:21-31`) instead of a fake `0 models`
  list, exactly per `2026-07-14-provider-auth-model-management.md` §5.1. The
  composer's send-block action copy is already precise and non-generic —
  `deriveComposerBlockingAction` (`model-availability.ts:29-42`) renders
  `Connect Claude Code` when auth is missing and `Choose a model for
  <connection>` when auth is ready but a model is required, explicitly
  never the banned generic "No models available for this session yet"
  string (comment at `model-availability.ts:24-27`).
- **A second-generation unified picker already exists and already does what
  the owner is asking for**: `ModelPicker`
  (`apps/web/src/features/session/model-picker/model-picker.tsx`), backed by
  `useModelPicker` (`packages/sdk/src/react/use-model-picker.ts`), is one
  popover for every harness. Harness selection happens upstream in
  `AgentSelector`; `useModelPicker` resolves the harness/connection fork
  internally (`use-model-picker.ts:27-36` — "the catalog-vs-harness fork is
  resolved HERE and only here") and exposes one flat `groups` shape a
  component never has to branch on. This is gated behind the
  `unified_model_picker` experimental flag (`apps/api/src/experimental/features.ts:156-168`,
  `platformDefault: () => false`) — **off for every project today**. Nobody
  who hasn't manually flipped a per-project Settings toggle has ever seen it.
- **The composer's send-gating architecture is correctly server-driven.**
  `capabilityBlocked` in `session-chat-input.tsx:1467-1468` is
  `composerCapabilityGoverned && !modelsLoading &&
  Boolean(composerBlockingReason)` — the client defers entirely to the
  server's capability answer and disables Send + shows `ModelConnectionBar`
  with one direct action (`session-chat-input.tsx:2245-2250`). This is the
  right architecture. It is also exactly why defect 1.2 below is so
  damaging: a correct client built on a lying server signal produces a
  confident, wrong "you're fine, send away."

### 1.2 The infinite-spinner bug is not a UX defect — it is a UX-invisible server truth-value bug, and the UX layer must change to make it structurally impossible anyway

Trace, confirmed independently of the architecture doc by reading the
frontend call sites:

1. `composerBlockingReason` / `capabilityBlocked` in
   `session-chat-input.tsx` is driven by the server's composer-capability
   response, which the client trusts completely — correctly, by design.
2. The server computes `can_start` from `computeDefaultAllowed`
   (`apps/api/src/projects/lib/composer-capabilities.ts:321-329`, cited
   verbatim in the architecture doc §1.6): `input.active === 'managed_gateway'`
   short-circuits straight to `true`, **without checking
   `presetsLength > 0`** the way every other non-owning harness is held to.
3. `connectionConfigured('managed_gateway', …)` is just the project's
   `llm_gateway` experimental flag (`composer-capabilities.ts:172-173` —
   `return gateway`), not a check that any model is reachable.
4. Result: a project with the gateway flag on (platform default) and zero
   usable models behind it gets `can_start: true`. Send is enabled. Session
   creation succeeds. The sandbox boots OpenCode pointed at a gateway with
   nothing to serve. `session-starting-loader.tsx`'s fourth boot step,
   `Connecting` (`session-starting-loader.tsx:76`, `activeStep()` returns 3
   once the backend reports `ready`), has no way to know the model behind it
   is unusable — it just waits. After `STUCK_AFTER_MS = 45_000`
   (`session-starting-loader.tsx:51`) it offers a manual restart — which
   restarts into **the identical dead end**, because the root cause (no
   usable model) survives a restart. This is a structural retry loop, not a
   spinner that eventually resolves.
5. Separately and independently, `model-selector.tsx` — the picker actually
   rendered for OpenCode when `unified_model_picker` is off — computes its
   own, unrelated "is anything usable" signal (`hasSelectableModels` /
   `useModelConnectionGate`, `use-model-connection-gate.tsx:69-73`), which
   **correctly** shows the empty state with `No models available` /
   `Connect a model service` (`model-selector.tsx:479-505`) in the same
   broken-catalog scenario. **The picker the owner looked at told the truth.
   The Send button, driven by a different, server-computed truth value, did
   not agree with it and let the send through anyway.** Two independently
   computed "is a model available" answers that can disagree is the actual
   defect class here — not a missing empty state, not a missing action
   button. The empty state and the action button already exist; they were
   simply overruled by the send path reading a different, wrong signal.

This is D2/D3 in the architecture doc, verified from the consuming side. The
fix is a single function in `composer-capabilities.ts` (not mine to edit —
owned elsewhere per this task's constraints), but **the UX contract this
document specifies in §4 depends on that fix landing**, and I say so
explicitly rather than silently assuming it: a UX spec that describes "must
be structurally impossible" states without naming the one signal that has to
stop lying would be decoration, not a fix.

### 1.3 D5, confirmed and sharpened: two "default model" concepts sit in the same nine lines of scroll and visibly contradict each other

`models-view.tsx:117-141` renders a `Default model` panel (label:
"Used when an agent doesn't pick its own") wired to `useModelDefaults` /
`useProjectModels` — the legacy gateway `auto` → account → platform default
chain, predating the four-harness work (per the file's own comment,
`models-view.tsx:52-55`: "relocated here from `gateway-view.tsx`'s tab bar").
Immediately below it, `Agent runtimes` renders `OpenCode  Kortix · Automatic`
(`runtime-row.tsx`). **These are, in the OpenCode/managed-gateway case, the
same underlying resolution** (managed-auto), presented through two
completely different controls with no visible link. A user who sets `Default
model` to a specific Anthropic model at the top of the page, then reads
`Kortix · Automatic` in the OpenCode row three inches below it, has no way to
know whether their choice took effect, was overridden, or applies to
something else entirely. Nothing on the page names which harnesses the top
panel affects (only gateway-catalog routes — OpenCode/Pi-on-Kortix — never
Claude/Codex/Pi-on-subscription). This is the second, independent source of
"the model selector is kind of fucked," and it is a pure UX/copy defect fully
inside my file scope (`models-view.tsx`).

### 1.4 Mobile has re-derived a third status vocabulary (D6, sharpened)

`apps/mobile/components/pages/LlmProvidersPage.tsx:96-100`:

```ts
function connectionStatus(row: ProviderRowModel) {
  if (row.connection?.ready) return 'Connected';
  if (row.connection?.configured) return row.connection.reason || 'Needs attention';
  return 'Not connected';
}
```

Web's status set is `Connected / Checking / Needs attention / Unavailable /
Choose connection / Needs connection` (`runtime-row.tsx:20-55`,
`connection-row.tsx:70-87`). Mobile independently hand-wrote a three-value
set that conflates "checking" into nothing and "unavailable" into "needs
attention." The two vocabularies already disagree today; any future status
(the architecture doc's D2 fix will add a real `hasModel` distinction) has to
be manually re-threaded into mobile by hand or mobile silently
misrepresents state. Mobile also organizes the same information as three
tabs (`providers` / `connected` / `models`, line 77) instead of web's
runtime-then-connections scroll — a second, independently maintained
information architecture for one underlying model (also D6).

### 1.5 Minor, but worth fixing while in these files

- `ModelPicker`'s empty-groups state (`model-picker.tsx:181-188`) renders
  prose only — `No models available` / `Try a different search, or connect a
  provider to see more models` — with **no button in that block**. The only
  way out is the generic `Manage models` footer link at the very bottom of
  the popover (`model-picker.tsx:200-212`), easy to miss directly under a
  paragraph that already said "connect a provider." The legacy
  `model-selector.tsx`'s equivalent empty state (lines 479-505) does the
  right thing — inline `Upgrade` / `Connect a model service` buttons — and
  `ModelPicker` should match it now that it is being promoted (§6).
- The `MultiHarnessToggle` appearing inside the connect modal
  (`multi-harness-toggle.tsx`) *and* in Customize → Settings → Experimental
  is good, deliberate design (surfacing the gate exactly where a user hits
  the wall), not a defect — noted here only so it is not mistaken for
  duplication to clean up.

---

## 2. The connect surface

### 2.1 Decision: keep the existing two-section page, fix the one contradiction, tighten copy

The Models page's shape (`Agent runtimes` above `Your connections`) already
satisfies "one coherent place" and "never duplicate one credential three
times" (§1.1). The work here is subtraction and clarification, not a rebuild.

**Remove** the standalone `Default model` panel (`models-view.tsx:117-141`).
**Replace** it with a one-line clarifying subtitle under the `Agent runtimes`
label the first time a project has more than one gateway-eligible runtime
(OpenCode and/or Pi with the managed connection active):

> Agent runtimes
> OpenCode and Pi use Kortix's Automatic routing unless you pick a model in
> their row below.

This removes the second control entirely rather than trying to keep it in
sync with the per-runtime rows — the runtime row `Change` selector already
lets a user set an explicit model for the gateway route
(`Change` → `Automatic` / a specific model, per `2026-07-14-provider-auth-model-management.md`
§5.1's `Change` control spec, already implemented via `ConnectionSelect`).
There is no remaining use case the removed panel served that the per-runtime
row does not already cover more precisely. (`account_model_preferences` /
headless callers that read the old chain directly are the architecture doc's
Part 4 step 4 concern — audit before deleting the write path itself; this
document only asks for the **UI control** to be removed, not the underlying
account-default resolution chain, which stays as the platform fallback
`useModelDefaults` already documents.)

### 2.2 Wireframe — Models page (flag on: `experimental_harnesses`)

```text
Models                                                        [+ Connect]
Connect model services and choose what each agent runtime uses.

Agent runtimes
OpenCode and Pi use Kortix's Automatic routing unless you pick a model in
their row below.
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude Code                              Connected                   │
│   Claude subscription · Harness default                      [Change ▾]│
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Codex                                    Needs attention             │
│   ChatGPT subscription needs to be reconnected                  [Fix]  │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ OpenCode                                 Connected                   │
│   Kortix · Automatic                                          [Change ▾]│
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Pi                                       Needs connection            │
│   Choose how Pi accesses models                             [Connect]  │
└────────────────────────────────────────────────────────────────────────┘
                                                       Manage agents →

Your connections
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude subscription                      Connected          [Manage] │
│   Used by Claude Code · Models managed by Claude Code                  │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ ChatGPT subscription                     Needs attention    [Manage] │
│   Needs attention · Token expired 2 hours ago                          │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Kortix                                   Connected           [Manage]│
│   Included with Kortix · 12 models available                          │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Making many-to-many legible without duplication

The current `Used by Claude Code and Codex` / `Used by OpenCode and Pi`
join-and-list pattern (`connection-row.tsx:13-18, 40-44`) already solves
"one credential, N harnesses, shown once." The gap is upstream, at the
**connect method list** (`connect-model-modal.tsx`): when a user is choosing
*how* to connect, they currently see one row per subscription
(`Claude Code`, `ChatGPT / Codex`, `connect-model-modal.tsx:180-203`) with no
inline indication of which harnesses that credential will light up before
they click it. Today, with subscriptions hard-pinned 1:1
(architecture doc D1), that's a non-issue — one credential really does mean
one harness. It becomes a legibility gap the moment D1/Option B ships
(Codex subscription widened to `[codex, opencode, pi]`). Since
`METHOD_COMPATIBLE_HARNESSES` already carries the exact answer
(`harness-method-compat.ts:40-42`), the fix is a one-line addition to
`MethodRow` (`connect-model-modal.tsx:374-404`): render the compatible-harness
list as small trailing icon chips, sourced from the same table already
imported by the file.

```text
Before (today, 1:1, chips would be redundant — do not add them while D1 is unshipped):
  [◆] ChatGPT / Codex                                    Connected
      ChatGPT Plus, Pro, Business, Edu, or Enterprise

After (the moment a credential covers >1 harness):
  [◆] ChatGPT / Codex                        [◆][◆][◆]   Connected
      ChatGPT Plus, Pro, Business, Edu, or Enterprise · Codex, OpenCode, Pi
```

This is intentionally **not built now** — building UI for a compatibility
set that does not exist yet would be speculative. It is specified here so
that the moment D1/Option B ships (a backend-only change to
`HARNESSES.codex.authKinds`), the UI change is a five-line diff to an
already-identified file, not a new design pass.

### 2.4 First-connection "Use for…" step

Already correctly specced and implemented (`forms/use-with-runtimes.tsx`,
`defaultUseWithHarnesses` pre-checks only runtimes with `status === 'missing'`
— i.e. it defaults ON exactly when it's the first compatible connection, per
`2026-07-14-provider-auth-model-management.md` §5.2, never silently stealing
an existing default). No change needed here beyond the D3 fix making
`status` itself trustworthy (§1.2).

---

## 3. The selection surface (composer)

### 3.1 Decision: harness selection is upstream of model selection — already correct, keep it, promote it

`AgentSelector` picks the logical agent (and therefore harness) first;
everything downstream — `HarnessModelSelector`, `ModelPicker`, the legacy
`ModelSelector` — is scoped to that resolved harness/connection. This is the
right model and matches `2026-07-14-provider-auth-model-management.md` §5.3
("The composer first selects a logical agent... That selection drives every
subsequent option") and `2026-07-12-multi-harness-auth-model-session-ux.md`
§7 ("select agent → load capabilities → show compatible auth+model state").
**Do not build a combined single control that merges harness and model
picking into one popover** — the asymmetry the brief calls out (model-id for
OpenCode/Pi-on-gateway vs. credential-is-the-selection for Claude/Codex/
Pi-on-subscription) is exactly why two separate, sequential controls are
correct: collapsing them would force one popover to sometimes mean "pick a
model" and sometimes mean "pick a credential," which is a worse asymmetry
than the two-control status quo. `useModelPicker` already absorbs the
model-vs-credential asymmetry correctly *within* the model control
(`use-model-picker.ts:27-36` — one harness-native group with an Auto item +
presets, vs. one group per catalog provider) — that is the right place for
the asymmetry to live, not the agent/harness selector.

### 3.2 Decision: promote `ModelPicker` from experimental to the default composer control

The `unified_model_picker` flag exists, is wired end-to-end
(`composer-chat-input.tsx:343-367`), and is exactly the "pick a harness, see
exactly the models reachable with the credentials on file" control the brief
asks for — it already resolves compatible connections, groups by them, and
renders a `connectAction` inline per disconnected group
(`model-picker.tsx:158-169`, `onConnect` wired to open the connect modal
pre-filtered to that connection kind). Leaving it permanently
project-opt-in means the polished version of exactly the surface this spec
was commissioned to fix is sitting unused. Recommendation: fix §1.5's empty-
state gap, run it through one release as the flagged default for new
projects, then flip `platformDefault` to `true` and delete the legacy
`ModelSelector`/`HarnessModelSelector` fork per the flag's own description
("replacing the separate gateway-catalog and harness-native selectors").
This is a product/rollout call, not mine to execute, but it is the single
highest-leverage move available and should not be silently left flagged-off
forever.

### 3.3 Wireframes — composer pill row

**OpenCode-only project (flag off), healthy:**

```text
[◆ kortix ▾]  [Auto ▾]  ⚡ Effort: —
 agent/harness  model
```

**Multi-harness project (flag on), Claude Code agent selected, subscription
ready:**

```text
[◆ Claude Code ▾]  [Auto ▾]
 agent/harness       ↳ opens: ✓ Auto — Claude Code decides which model to run
                           Custom model ID…
                           ──────────────────────────
                           Models managed by Claude Code · via Claude subscription
```

**Multi-harness project, Pi agent selected, no connection at all (`missing`):**

```text
[◆ Pi ▾]  [Connect Pi ▾]      ← pill itself becomes the CTA, not a picker
```

Model pill renders as a direct action rather than an empty popover trigger
when `runtime.status === 'missing'` — this is a **new** small behavior (today
the model control still opens an empty/near-empty popover in this state per
`harness-model-selector.tsx`'s unconditional render). Concretely: when
`compatibleConnectionIds.length === 0` for the resolved harness, render the
model-pill slot as a `Button` reading `Connect <Harness>` that opens the
connect modal pre-filtered, instead of mounting `HarnessModelSelector` /
`ModelPicker` at all. This removes one more path to an empty-but-clickable
popover.

### 3.4 The asymmetry table (what "model" means per harness)

| Harness | What "model" means | Control shown | Source |
|---|---|---|---|
| Claude Code | `Auto` (harness default) or a free-text model id override | Auto row + optional custom-ID field, no browsable list | `harnessSubscriptionCopy`, `isSubscriptionConnection` |
| Codex | Same as Claude Code | Same | Same |
| Pi (on API key / custom endpoint) | A concrete preset id from `models.dev`, capped to newest 6 (`NATIVE_MODEL_PRESET_LIMIT`) | Auto row + browsable preset list + custom-ID field | `composer-capabilities.ts:261` |
| Pi (on Kortix managed) | A concrete catalog entry, potentially thousands | Auto row + searchable preset list (capped render, full search) | `filterHarnessPresets` cap logic |
| OpenCode (on Kortix managed) | Same as Pi-on-managed | `ModelSelector` (legacy) grouped by real provider, or `ModelPicker`'s catalog groups | `pickerGroupId`/`pickerGroupLabel` |
| OpenCode (on native config) | Whatever `.opencode`'s committed config declares | Runtime row reads "Project config," no composer override control (native config is presence-detected, D7) | `composer-capabilities.ts` `native_config` |

This table is the concrete answer to "the design must absorb the asymmetry
without confusing anyone": for subscription-backed harnesses, the model
control is deliberately **shallow** (one Auto row, one optional text field —
no catalog to browse because none is authoritative); for catalog-backed
routes it is deliberately **searchable**. The user never has to learn which
mode they're in — the control's own shape (search box present or absent)
communicates it.

---

## 4. Empty, degraded, and error states

### 4.1 Structural requirement (ties to §1.2)

A session must never reach the sandbox-boot phase with a route that resolves
to zero usable models. The composer's existing `capabilityBlocked` gate
already has the correct architecture for this (§1.1) — it only needs the
server's `can_start` signal to stop returning `true` for an empty
managed-gateway catalog (architecture doc D3). Once that lands, every state
below is a direct rendering of `composerBlockingReason` /
`composerBlockingActionLabel` /  `composerConnectKind`, which already exist
as props. No new client-server contract is needed — the existing one just
needs to stop being fed a wrong value in this one case.

### 4.2 State table — credential kind × harness × resulting model availability

| Credential | Claude Code | Codex | OpenCode | Pi |
|---|---|---|---|---|
| Claude subscription | Auto + custom-ID, no catalog ("Models managed by Claude Code") | not compatible | not compatible | not compatible |
| Anthropic API key | Auto + capped preset list (models.dev) | not compatible | Auto + full catalog | Auto + full catalog |
| ChatGPT/Codex subscription | not compatible | Auto + custom-ID, no catalog ("Models managed by Codex") | not compatible **today**; technically safe per architecture doc §1.2, proposed in D1/Option B | not compatible **today**; same |
| OpenAI API key | not compatible | Auto + capped preset list | Auto + full catalog | Auto + full catalog |
| OpenAI-compatible custom endpoint | not compatible | not compatible | Auto (endpoint default) or required explicit model if the endpoint declares none | Same as OpenCode |
| Anthropic-compatible custom endpoint | **parked**, no harness compatible, not offered in connect flow | — | — | — |
| Kortix managed gateway | not compatible (harness-only policy) | not compatible (harness-only policy) | Auto + full catalog, **requires non-empty `gatewayModelCatalog(projectId)` to actually be `can_start`-eligible — the D3 fix** | Same as OpenCode |
| Native/`.{harness}` config | Compatible with its own owning harness only (`native_config` in `authKinds` per harness) | Same | Same | Same |

Blank/"not compatible" cells are **not shown as options at all** in the
connect flow (`compatibleWithFilter`, `connect-model-modal.tsx:74-80`) —
there is no disabled/greyed row for an incompatible pairing anywhere in this
design; absence is the signal, matching
`2026-07-12-multi-harness-auth-model-session-ux.md` §12.2's "Also assert
every incompatible pairing is absent/rejected."

### 4.3 Copy deck

Every row: **State** → **Copy** → **Action**. Copy already shipped is marked
`[existing]`; copy this document specifies as new/changed is marked `[new]`.

**Models page — runtime row**

| State | Copy | Action |
|---|---|---|
| Ready | `<Connection> · <model policy>` (e.g. `Claude subscription · Harness default`) | `Change` `[existing]` |
| Checking | `Checking <connection>…` | disabled `Change` + spinner `[existing]` |
| Missing | `Choose how <Runtime> accesses models` | `Connect` `[existing]` |
| Ambiguous (2+ ready, no default) | `Select one of N connected options` | `Choose` `[existing]` |
| Needs attention | `<Connection> needs to be reconnected` | `Fix` `[existing]` |
| Unavailable | `<Connection> could not be reached` | `Fix` (retry via manage modal) `[existing]` |
| **Ready connection, verified-empty catalog** (managed gateway or custom endpoint, no models) | `Kortix has no models available for this project right now` / `<Endpoint> has no models configured` | `Manage` → opens the connection's model/discovery section `[new — requires D3]` |

**Composer — model/agent pill and send block**

| State | Copy | Action |
|---|---|---|
| No auth for resolved harness | `Connect <Harness>` (button IS the pill, §3.3) `[existing pattern, new placement]` | opens connect modal pre-filtered |
| Auth ready, model required, none chosen | `Choose a model for <Connection>` | opens model picker `[existing]` |
| Auth ready, harness owns its default | Send enabled, pill reads `Auto` | none required `[existing]` |
| Subscription connection, no catalog | `Models managed by <Harness>` in the picker body | none — informational `[existing]` |
| **Verified-empty catalog behind an otherwise-ready connection** | `<Connection> has no models available. Manage the connection to add one.` | `Manage models` `[new — requires D3]` |
| Expired/revoked subscription | `<Connection> needs to be reconnected` | `Reconnect <Harness>` `[existing pattern]` |
| Custom model rejected upstream | `<Harness> rejected "<model id>" via <Connection>: <redacted upstream error>` | edit/try another `[existing per spec 07-14 §5.4, verify at implementation]` |
| Session-create blocked (`COMPOSER_CAPABILITY_BLOCKED`) | Toast: `composerBlockingActionLabel \|\| composerBlockingReason \|\| "This agent is not ready to start."` | same action as the pill `[existing]` |

**Boot loader (`session-starting-loader.tsx`)**

| State | Copy | Action |
|---|---|---|
| Normal 4-step progress | unchanged (`Provisioning… / Preparing… / Starting… / Connecting`) | none `[existing]` |
| **Stuck at "Connecting" past `STUCK_AFTER_MS`, session has no usable model** | Should never occur once §4.1 lands — session creation itself is blocked before this loader ever mounts. If it is somehow reached anyway (e.g. a route that became invalid mid-session), the existing manual-restart fallback stays, but the toast/tooltip on restart should say `This agent's model connection changed. Reconnect it, then try again.` instead of a bare restart affordance that will loop `[new — defensive, only reachable via race, not the primary fix]` | `Restart` (existing) + link to Models page (new) |

**Models page — connections list (existing, correct, listed for completeness)**

| State | Copy |
|---|---|
| Managed gateway healthy, no user connections | `Kortix's managed models are included — no setup needed.` `[existing, `KORTIX_INCLUDED_TITLE`]` |
| Managed gateway unhealthy, no user connections | `No model services connected yet` `[existing]` |
| Subscription/API key connected | `Used by <Harness list> · <N> models available` or `Models managed by <Harness>` `[existing]` |
| Needs attention | `Needs attention · <reason>` `[existing]` |

### 4.4 What makes the infinite spinner structurally impossible

Three independent layers, all already partially built, none of them new
architecture:

1. **Server**: `can_start` must be `false` whenever the resolved connection
   is `managed_gateway` and `presetsLength === 0` (D3 fix, not mine to
   implement, but the dependency this whole section rests on).
2. **Composer**: `capabilityBlocked` already disables Send and shows
   `ModelConnectionBar` the instant `can_start` is `false` — no change
   needed once (1) lands.
3. **Boot loader**: because (1)+(2) block session creation itself, the
   loader's fourth step can only be reached with a route that was valid at
   creation time — the residual "stuck at Connecting" case becomes a genuine
   runtime failure (sandbox/network), not a silently-unusable-model case, and
   deserves its own honest timeout copy (§4.3's defensive row) rather than a
   restart loop.

---

## 5. OpenCode-first default

### 5.1 Flag off (the common case — must stay light)

With `experimental_harnesses` off (`experimental_harnesses.platformDefault`
is `false`, `apps/api/src/experimental/features.ts:144-155`), a project sees
exactly one agent runtime row, one connection type realistically in play
(Kortix managed, plus optional BYOK), and the composer pill reads
`[◆ kortix ▾]` with no harness-switching affordance at all — `AgentSelector`
still renders (agents can still be OpenCode-named agents like `build`), but
every agent resolves to the same harness, so the harness icon never
changes and the row never shows a second brand. The Models page shows one
`Agent runtimes` row (`OpenCode`) and the connections list. **No multi-
harness copy, toggle, or affordance should render anywhere in this state** —
today's implementation already respects this (`MultiHarnessToggle` returns
`null` when `!feature?.available` is false — actually renders based on
platform availability, not the per-project enable state, so it *does* show
up as an off `Switch` inside the connect modal even for a pure-OpenCode
project. That is correct per the "surfaced where users hit the wall" design
(§1.5) — it is a single quiet row inside a modal a user opened deliberately
to connect something, not a persistent top-level tax on the default
experience. No change needed.

### 5.2 Flag on

Once a project enables `experimental_harnesses`, the four-harness `Agent
runtimes` list, the brand-row agent picker (Claude Code / Codex / Pi read as
the harness name, `BRAND_ROW_HARNESSES` in `agent-selector.tsx:53`), and the
full connect-method catalog (subscriptions section) become visible. This is
already correctly gated — verified by reading `agent-selector.tsx`'s
`agentDisplayName`/`agentHoverDescription` and the runtime-status dot logic
(`isHarnessDisconnected`, lines 240-242) which only ever has data to show
once `useModelsPage` returns non-OpenCode runtimes, which only happens once
the flag is on and the project's `kortix.yaml` declares those runtimes. No
structural change needed here — only the copy/removal fixes from §2.1 and
the empty-state fix from §1.5, both of which apply identically whether the
flag is on or off (OpenCode-on-gateway can hit the empty-catalog case
regardless of the flag).

---

## 6. Deliverables

### 6.1 Wireframes

See §2.2 (Models page) and §3.3 (composer pill row, three states). Additional:

**Connect modal — method list, unchanged shape, annotated for the future
many-to-many chip (§2.3):**

```text
Connect a model service
Use a subscription, API key, or compatible endpoint.

Subscriptions
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude Code                                                        + │
│   Claude Pro, Max, Team, or Enterprise                                 │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ ChatGPT / Codex                                          Connected + │
│   ChatGPT Plus, Pro, Business, Edu, or Enterprise                      │
└────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────┐
  │ Multi-harness  [Experimental]                          ( off ●) │
  │ Run sessions on Claude Code, Codex, and Pi in addition to        │
  │ OpenCode. May change between versions.                           │
  └──────────────────────────────────────────────────────────────────┘

API keys & endpoints
[ Search providers… ]
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Anthropic                                                          + │
│   Claude via your own API key                                          │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ OpenAI                                                              + │
│   GPT models via your own API key                                      │
└────────────────────────────────────────────────────────────────────────┘
```

**Mobile — recommended realignment (D6 fix, not built by this document, but
specified for the implementer):**

Replace the three-tab (`providers`/`connected`/`models`) structure with the
same two-section, single-scroll model web uses: `Agent runtimes` then
`Connections`, using the same status vocabulary (`Connected / Checking /
Needs attention / Unavailable / Choose connection / Needs connection`)
instead of the hand-written `connectionStatus()` three-value set. This is a
real, if lower-priority, piece of work — flagged here per the brief's ask to
cover both platforms, but not detailed to wireframe level because mobile is
outside this worktree's primary UI focus per the task framing (web is
canonical; mobile "heavily rewritten in this PR" per the task brief, meaning
it is actively being iterated by someone else right now — this document
gives the target status vocabulary and page shape, not a full mobile
redesign).

### 6.2 State table

See §4.2 (credential × harness × availability) and §3.4 (harness × what
"model" means).

### 6.3 Copy deck

See §4.3, complete.

### 6.4 Implementation list

Ordered by dependency. Each item names the exact file(s). "Small" = editing
an existing component/prop; "New" = a component, state, or behavior that
does not exist today. Items marked **(blocked on D3)** cannot ship correctly
until the architecture doc's server-side fix lands — they can be built and
tested against a mocked capability response in the meantime.

1. **New (small, my file scope)** — Remove the standalone `Default model`
   panel from `apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx`
   (lines 117-141) and its now-unused `useModelDefaults`/`useProjectModels`/
   `gatewayRoutingPolicyKey` wiring (lines 52-63); add the one-line
   clarifying subtitle under `Agent runtimes` per §2.1, only rendered when a
   gateway-eligible runtime (OpenCode/Pi with `managed_gateway` active) is
   present.
2. **Small** — `apps/web/src/features/session/model-picker/model-picker.tsx`:
   give the empty-groups block (lines 181-188) the same inline `Upgrade` /
   `Connect a model service` buttons `model-selector.tsx` already has (lines
   487-503), instead of prose-only + a footer link.
3. **Small** — `apps/web/src/features/workspace/customize/sections/llm-provider/connect-model-modal.tsx`:
   `MethodRow` (lines 374-404) — add optional trailing compatible-harness
   icon chips, sourced from `METHOD_COMPATIBLE_HARNESSES`
   (`harness-method-compat.ts`), rendered only when `compatible.length > 1`
   (today: never, since only API keys qualify and they already read fine
   without chips — this becomes load-bearing the moment D1/Option B ships).
4. **New (small)** — Composer model-pill slot: when
   `runtime.compatibleConnectionIds.length === 0` for the resolved harness,
   render a direct `Connect <Harness>` button in place of mounting
   `HarnessModelSelector`/`ModelPicker` at all. Touches
   `apps/web/src/features/session/composer-model-controls.tsx` (the
   dispatch point) — add a `missingConnection` branch before the existing
   `modelPicker ? … : …` fork.
5. **(blocked on D3, not mine to implement — composer-capabilities.ts is
   out of scope for this document)** — Server: `computeDefaultAllowed` must
   require `presetsLength > 0` for `managed_gateway` the same way it already
   does for every other non-owning harness. This is the architecture doc's
   D3/Option A fix and the actual root cause of the reported hang.
6. **New (small, depends on 5)** — Add the "verified-empty catalog on an
   otherwise-ready connection" copy row from §4.3 to wherever
   `composerBlockingReason` strings are rendered/derived on the client
   (`model-availability.ts`'s `deriveComposerBlockingAction` is the natural
   home — it already branches on `authReady`; add a third branch for
   `authReady && connectionReady && catalogEmpty`). Requires the server to
   actually emit a distinguishable reason for this case, which is part of
   item 5's scope, not separately inventable client-side.
7. **New (small, defensive)** — `session-starting-loader.tsx`: change the
   `STUCK_AFTER_MS` fallback copy to the model-aware message from §4.3's
   boot-loader row, and link the restart affordance to the Models page
   instead of only offering a bare restart.
8. **Product/rollout decision, not a code change I can specify further
   here** — promote `unified_model_picker` from opt-in experimental to
   platform default per §3.2, after items 2 and 6 land (the picker's empty
   state and blocked-reason copy need to be correct before it becomes the
   only picker). Owner: whoever owns `apps/api/src/experimental/features.ts`
   and the rollout process (kortix-release skill's normal flow applies).
9. **Out of this document's scope, named for completeness** — mobile
   realignment (§6.1's mobile section) and the D1/Option B backend widening
   of `codex_subscription`'s `authKinds` are real, correctly-scoped pieces
   of follow-on work but belong to whoever owns
   `apps/mobile/components/pages/LlmProvidersPage.tsx` and
   `packages/shared/src/harnesses.ts` respectively — both currently flagged
   as being worked on by other agents per this task's constraints.

---

## 7. Open questions for the owner

1. **Is the Claude subscription OAuth token safe/permitted to hand to a
   non-`claude-agent-acp` process at all?** This gates whether
   `claude_subscription` can ever widen to `[claude, opencode, pi]` the way
   Codex's technically already can. Not an engineering call — the
   architecture doc flags it and I am repeating it because §2.3's future
   chip design silently assumes an answer either way; if the answer is "no,
   never," the chip design should visually distinguish Claude's row as
   permanently 1:1 rather than "not yet widened."
2. **Should `unified_model_picker` actually replace the legacy fork, or stay
   a permanent opt-in?** The flag's own description says "replacing" — if
   that is still the intent, §3.2's promotion plan is the path; if the
   product decision has quietly changed to "keep both forever," that should
   be recorded somewhere, because right now nothing explains why a materially
   better, fully-built control is invisible by default.
3. **Does the removed `Default model` panel's underlying
   `account_model_preferences` chain still need a UI surface anywhere**
   (e.g. account-level settings, not project-level), or was the project-page
   widget the only consumer? I did not audit headless/trigger/schedule
   callers of that chain (architecture doc explicitly left this unaudited
   too) — removing the UI control per §2.1 does not remove the underlying
   preference data or its resolution order, only the confusing duplicate
   control.
4. **What is the actual behavior when OpenCode boots against a gateway
   config with zero models** — does the sandbox surface a terminal ACP error,
   retry silently, or truly hang? The architecture doc marks this
   **unverified** and so do I; §4.4's claim that fixing D3 makes the spinner
   "structurally impossible" depends on session creation being blocked
   *before* boot, which sidesteps needing to answer this, but it would still
   be worth knowing for the defensive copy in item 7 of §6.4.

---

## 8. Extension — gateway-central transport, visible compatibility, and the subscription-vs-metered distinction

Status: proposed, ready for review
Date: 2026-07-21 (follow-up round)

This section extends §§1–7 rather than replacing them. Everything above still
stands — in particular §3.2's recommendation to promote `ModelPicker` has
already been acted on (`apps/api/src/experimental/features.ts:164-171`,
`platformDefault: () => true` as of this writing, its own code comment citing
this document by name), and this section is written **against that promoted
picker as the baseline**, not the legacy `model-selector.tsx` fork. It also
does not re-litigate §3.2's transport question — the product owner has made
a decision (§8.0) that changes some of the assumptions §§1–7 were written
under, and this section reconciles the difference explicitly rather than
silently.

### 8.0 The decision this section designs for

The LLM gateway is staying and becomes **the single central transport for
all four harnesses**, not just OpenCode/Pi's optional route. Claude Code and
Codex will be pointed at the gateway using their own native custom
model/base-URL configuration options, the same mechanism `openai_compatible`
custom endpoints already use for OpenCode/Pi today. A separate agent owns
that transport/architecture plan; **this document assumes it succeeds** and
designs only the UX layer on top of it. Two things follow that materially
affect this section's design, stated up front:

- **§2.3's "do not build speculative many-to-many chips" instruction is
  superseded for the Codex side.** In §2.3 I declined to build UI for a
  compatibility set that didn't exist in the backend yet, and said to build
  it "the moment D1/Option B ships." The owner has now made that widening an
  explicit product goal (not merely "technically possible," per the
  architecture doc's D1 finding that Codex's server-proxied credential was
  already safe to widen). §8.1–8.2 below design it properly. It is still
  **not shipped code today** — the compatibility chips and "used by 3
  harnesses" copy in this section describe the target state once the
  transport plan lands, and every piece of UI in this section that depends
  on it is marked accordingly.
- **The Claude side stays explicitly unresolved.** The architecture doc's
  open question ("is Anthropic's subscription OAuth token safe/permitted to
  hand to a non-`claude-agent-acp` process") is about the *token leaving
  Kortix's server*. Pointing Claude Code's own native config at the gateway
  as a custom base URL is a different mechanism — Claude Code itself still
  holds and uses its own subscription token locally; only its *model
  requests* would route through the gateway for cost-tracking/fallback
  purposes, the token itself never relocates. This may sidestep the ToS
  question entirely, but I did not verify that distinction against
  Anthropic's actual terms and it is not mine to conclude — flagged again in
  §8.6. The design below therefore treats Claude subscription as **pinned to
  one harness by default, with the many-to-many presentation gracefully
  degrading to a single-harness row** rather than assuming it widens too.

### 8.1 The compatibility matrix as a first-class, visible thing

**Decision: do not build a matrix/grid UI.** A literal rows-of-credentials ×
columns-of-harnesses table is exactly the "spreadsheet" the owner explicitly
does not want, and it also does not match how a user actually approaches the
page — a user thinks "what does *this* connection unlock," not "let me scan
a grid." The existing information architecture already answers that
question per-row (`connection-row.tsx`'s `metadataLine`, §1.1); the fix is
making the **fan-out itself** — one connection lighting up multiple
harnesses — impossible to misread as three separate connections, in exactly
the two places a user forms that belief: the connections list, and the
connect method list.

**Connections list — already correct, gets stronger under the new data.**
`metadataLine()` (`connection-row.tsx:30-45`) already renders `Used by
<joinAnd(harnesses)>` for a connection active on multiple harnesses. Today
that function is exercised almost nowhere (only API keys reach >1 harness,
and even then only when actively selected for more than one). Once Codex
subscription's `compatible_harnesses` genuinely includes `[codex, opencode,
pi]`, the exact same unchanged code renders:

```text
◆ ChatGPT / Codex                                     Connected   [Manage]
  Used by Codex, OpenCode, and Pi · Models managed by Codex
```

No new component. This is the concrete payoff of §1.1's earlier finding that
the compatibility data model was already many-to-many-native — the fan-out
render path was built for this day and has been sitting idle.

**Connect method list — the one place that needed new UI, specified in §2.3,
now promoted from "future" to "build this."** Add the compatible-harness
icon row to `MethodRow` (`connect-model-modal.tsx:374-404`), rendered
whenever `compatible.length > 1`:

```text
Subscriptions
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude Code                                                        + │
│   Claude Pro, Max, Team, or Enterprise                                 │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ ChatGPT / Codex                          [◆Codex][◆OpenCode][◆Pi]  + │
│   ChatGPT Plus, Pro, Business, Edu, or Enterprise                      │
└────────────────────────────────────────────────────────────────────────┘
```

Claude Code's row renders **no chip row at all** — a single-harness
credential shows exactly like it does today, silently, no "1 harness" badge
that would read as a lesser/limited version. Absence of the fan-out
indicator *is* the "pinned to one" signal, the same way absence already
communicates incompatibility elsewhere in this design (§4.2). This is the
concrete graceful-degradation behavior the owner asked for: if Claude never
widens, this row never changes from what ships today; if it later does
widen, it automatically grows chips the moment `METHOD_COMPATIBLE_HARNESSES`
says so — same mechanism, zero new conditional logic, because the chip row
is driven by `compatible.length`, not a hardcoded harness name.

**API keys keep their existing fan-out presentation unchanged** — Anthropic/
OpenAI API key rows already show no chips today (their compatible-harness
count is 2–3 but this UI element didn't exist until now); once built, the
same rule applies to them too, so `Anthropic` gains `[◆Claude][◆OpenCode]
[◆Pi]` chips automatically. Nothing provider-specific here — this is one
generic rule (`compatible.length > 1` → render chips from
`METHOD_COMPATIBLE_HARNESSES`) applied uniformly across every connect
method, including future ones.

### 8.2 One credential, many harnesses, shown once — the runtime-row side

§8.1 covers the *connections* list. The *runtime* list needs the inverse
guarantee: selecting a harness must never look like a separate reconnect.
`RuntimeRow`'s `Change` control (`runtime-row.tsx:82-93`,
`ConnectionSelect`) already lists only compatible ready connections and
reuses the *same connection object* across rows — verified by reading
`runtime-row.tsx`: nothing in that component creates or clones a connection
per harness, it only ever reads `runtime.selectedConnectionId` against the
shared `connections` array passed down from `useModelsPage`. Concretely,
once Codex subscription is active for all three eligible harnesses, three
separate runtime rows each read:

```text
◆ Codex                                     Connected
  ChatGPT subscription · Harness default                       [Change ▾]
◆ OpenCode                                  Connected
  ChatGPT subscription · Automatic                              [Change ▾]
◆ Pi                                        Connected
  ChatGPT subscription · Harness default                        [Change ▾]
```

Same connection name, verbatim, in all three rows — this is already the
correct pattern (`<connection> · <model policy>`, per the 07-14 handoff's
locked anatomy) and needs no new component. **What does need a small addition**:
today, connecting a *new* Codex subscription for the first time defaults
"Use with…" to only the harnesses currently `missing` (`defaultUseWithHarnesses`,
`forms/use-with-runtimes.tsx:17-25`) — correct behavior, unchanged. But once
a Codex subscription already exists and is active for Codex only, and a user
later turns on `experimental_harnesses` to unlock OpenCode/Pi, those two new
runtime rows land in `missing` state with **no automatic adoption** — the
user has to manually `Change` each one to the already-connected Codex
subscription, even though the connection was ready the whole time and is
now the obviously-first choice. This is a one-line UX gap worth naming: when
a previously out-of-scope runtime becomes selectable (flag turned on, or a
harness's `authKinds` widens), and exactly one ready compatible connection
already exists, that runtime's row should default its resolution to that
connection rather than sitting in `Needs connection` waiting for a manual
`Change`. This is a resolver-precedence behavior (`resolveActiveHarnessConnection`,
`composer-capabilities.ts:226-253` already has "exactly one ready connection
→ auto-adopt" logic for the *ambiguity-free* case) — worth confirming it
already covers "newly-eligible harness, pre-existing single ready
connection" or whether that's a gap; not confirmed either way in this pass,
flagged for whoever owns that file.

### 8.3 Default model selection in a gateway-central world

**The §2.1 recommendation to delete the duplicate `Default model` panel
still stands, and gateway-centrality makes it stronger, not weaker.**
Reasoning: §1.3/§2.1's objection was never "the gateway-default concept is
wrong" — it was that having **two separate controls** for the same
resolution (a page-top panel plus a per-runtime row) with no visible
relationship is what read as broken. A gateway-central world doesn't
introduce a new need for a second control; if anything it removes the
argument for one, because "the gateway" stops being one-of-several-routes
that only some runtimes use and becomes *the* transport underneath every
harness. That makes the per-runtime row's `Automatic` /  `<explicit model>`
state **more** authoritative as the single source of truth for "what
actually ran," not less — a page-top panel duplicating it would now be
duplicating the default for four rows instead of two.

**What "set my default model, simply" means once the gateway is universal:**
the owner's ask reduces to one control, one level higher than today's
per-runtime rows: a single **project-level default model** action that sets
the gateway's own resolution (the existing `account_model_preferences` /
`useModelDefaults` chain §1.3 already named) — but surfaced as a *setting
inside the gateway connection itself*, not as a competing page-top widget.
Concretely: move the control from `models-view.tsx`'s page-top panel into
`ManageConnectionModal` (`manage-connection-modal.tsx`), specifically the
`Kortix` connection's manage view, alongside its existing model list
(§7's `catalogState === 'available'` branch, lines 190-199). This keeps the
precedence chain **unchanged** (explicit session choice > per-agent > account
> platform, per `default-model-resolution.md`, still the resolver's job, not
this document's) and gives it exactly one home: open `Kortix` → `Manage` →
`Default model`. A user who wants "just pick my default model" opens the one
connection that is, in a gateway-central world, definitionally the thing
that has a default — they are no longer choosing between two mental models
of where defaults live, because there is only one gateway connection to
manage now, and every harness routes through it.

```text
Manage — Kortix
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Kortix                                                    Connected  │
│   Included with Kortix · Auto-selects the best available model         │
├────────────────────────────────────────────────────────────────────────┤
│ Used by                                                                 │
│ Claude Code, Codex, OpenCode, Pi                                        │
├────────────────────────────────────────────────────────────────────────┤
│ Default model                                        [ Auto        ▾]  │
│ Used by any runtime that hasn't picked its own model.                  │
├────────────────────────────────────────────────────────────────────────┤
│ Models                                                                  │
│ 12 models available                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

This is a **small relocation**, not new architecture: the same
`ModelSelector`/`useModelDefaults` write path §2.1 already flagged as
mechanically portable moves one level down, into a modal that already
exists and already renders this connection's model list right next to
where the new control lands. No duplicate control anywhere on the page —
exactly one place, reached the same way every other connection's settings
are reached.

### 8.4 The subscription-vs-metered distinction, made visible

This is the sharpest new requirement and it is a **billing-correctness UX
problem wearing a design-system costume**: per
`docs/specs/2026-07-21-codex-billing-leak-verification.md` (read-only,
verified with file:line + one live probe by a separate agent), a connected
Codex subscription is silently bypassed today — the sandbox authenticates to
Kortix's own `/router/openai` proxy with a session token, Kortix's own
platform key pays OpenAI, and the user's Kortix credit balance is **also**
debited at a 1.2× markup for the same request (`billing-leak-verification.md`
§"Net effect confirmed"). The user connected a subscription specifically so
metered billing would not apply, and metered billing applied anyway, with no
UI anywhere telling them.

**This document does not fix the billing path** (owned elsewhere, and
explicitly out of my file scope). What is in scope, and is a real,
independent UX defect regardless of when the billing fix lands: **nothing in
today's UI is capable of telling a user which credential actually paid for a
session, at any point in the product** — not on the Models page, not in the
composer, not on the completed-session view. Even after the billing bug is
fixed, a user has no way to *verify* the fix worked from the product surface
alone. That gap is what this section closes.

**Principle: every place a connection or a session shows "in use," it must
show *how* — subscription-covered or Kortix-metered — never just "in use."**

**8.4.1 — Connections list.** Extend `metadataLine()`
(`connection-row.tsx:30-45`) to append a billing-mode tag, sourced from a
new field the capability response would need to carry (`billingMode:
'subscription' | 'metered' | 'unknown'` — naming only, not mine to add to
the API contract, but the client-side rendering rule is fully specified
here):

```text
◆ ChatGPT / Codex                                     Connected   [Manage]
  Used by Codex, OpenCode, and Pi · Models managed by Codex
  Billed to your ChatGPT subscription — not Kortix credits
```

```text
◆ Kortix                                              Connected   [Manage]
  Included with Kortix · 12 models available
  Billed in Kortix credits
```

Subscription rows get a small `Badge variant="outline" size="xs"` reading
`Subscription` next to the connection name, so it's visible even before
reading the metadata line — matching the existing `Badge` vocabulary
(§ Kortix design system) rather than inventing a new visual language for
billing state.

**8.4.2 — Composer, not just settings.** This is the part the brief
specifically calls out and today's UI has zero coverage of. Add one small,
persistent, low-emphasis line to the model pill's hover state (`Hint` on
`ModelPicker`'s trigger, `model-picker.tsx:127-129`, which already renders a
`hintLabel` combining `trigger.label`/`trigger.sublabel`) — extend that
sublabel to include billing mode whenever the resolved connection is a
subscription:

```text
Trigger: [Auto ▾]
Hint on hover: "Auto — via ChatGPT subscription · not billed to Kortix credits"
```

For a metered/gateway-backed session, the hint stays exactly as it is today
(`vm.trigger.sublabel`, no change) — the addition only fires for subscription
connections, so the common metered case gets zero new visual weight, per
§8.5's "keep the common case pristine" constraint. This is a `sublabel`
string change in `useModelPicker`'s trigger construction
(`packages/sdk/src/react/use-model-picker.ts`), not a new component —
flagged as the SDK's responsibility since the view-model already owns
`trigger.sublabel` end to end and a presentational component should not
special-case billing copy itself.

**8.4.3 — After a session runs, in the transcript/session header.** Not
detailed to wireframe level (outside this pass's primary surfaces per the
task's file-scope constraints — session-start/ACP-connect files are
explicitly owned elsewhere), but named because "unambiguous which credential
paid" has to survive past the composer: the session header or a turn's usage
metadata should carry the same `subscription` vs `metered` distinction shown
in the composer, so a user auditing a past session (or Kortix support
investigating a billing complaint) doesn't have to reverse-engineer it from
timestamps and a separate connections list. Flagging as a requirement on
whoever owns the transcript/usage surfaces, not specifying its layout here.

**8.4.4 — "Never show a credential as in use when it isn't."** This is the
direct UI-side mitigation for the exact bug in the leak doc: `usedBy` /
`active_for` (`connection-row.tsx`'s `usedBy`, `composer-capabilities.ts`'s
`active_for`) must reflect **actual routing**, not merely "this connection is
the selected/preferred one." Today those two things are conflated by
construction — `active_for` is computed from `project.metadata`'s stored
route selection (`buildHarnessConnections`, `composer-capabilities.ts:189-215`),
which is exactly the layer the billing leak bypasses: the connection *is*
marked `active_for: ['codex']` (the user picked it, correctly), while the
actual outbound request silently goes through the unrelated metered proxy
path. No UI change can fix that by itself — the field itself needs to mean
"is actually the credential the last successful turn billed through," which
requires the server to know that, which is exactly what the referenced
billing-leak fix has to establish. Naming this precisely so nobody mistakes
a future "add a `Subscription` badge" UI patch for a fix — the badge is only
honest once the underlying `active_for`/billing-mode signal is honest.

### 8.5 Keep the OpenCode-first common case pristine — confirmed against the shipped default

Confirms and updates §5.1 against the current state of the codebase, not
just the plan: `876742672` ("feat(harness): OpenCode-first by default,
multi-harness behind experimental flag") has already shipped — new projects'
`kortix.yaml` declares OpenCode only, the starter's `.claude`/`.codex`/`.pi`
stub native-config files were deleted from the templates
(`packages/starter/templates/base/`), and `runtime-view.tsx`/
`runtime-view-model.ts` now filter experimental-harness rows out of Customize
→ Runtime entirely when the flag is off (per that commit's diff to those two
files). Every piece of this section — the compatibility chips (§8.1), the
multi-row fan-out (§8.2), the relocated default-model control (§8.3), and
the billing-mode badges (§8.4) — only has surface area to render once a
project has more than one connected/eligible harness, which requires
`experimental_harnesses` on. A pure-OpenCode project never sees compatibility
chips (there is only ever one connect-method row group relevant to it),
never sees a multi-row fan-out (only one runtime row exists), and the
relocated `Default model` control (§8.3) is the *only* piece of this section
that renders unconditionally — because the `Kortix` connection is
universal and every project has one, flag or not. That is intentional and
correct: "set my default model" is not an experimental-harness concept, it
is a Kortix-connection concept, and it should be reachable in the common
case exactly as easily as in the multi-harness one — one `Manage` click on
the one connection every project already has.

**Wireframe — flag off, the common case, post-`876742672`, post-§8.3 relocation:**

```text
Models                                                        [+ Connect]
Connect model services and choose what each agent runtime uses.

Agent runtimes
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ OpenCode                                 Connected                   │
│   Kortix · Automatic                                          [Change ▾]│
└────────────────────────────────────────────────────────────────────────┘

Your connections
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Kortix                                   Connected           [Manage]│
│   Included with Kortix · 12 models available                          │
│   Billed in Kortix credits                                             │
└────────────────────────────────────────────────────────────────────────┘
```

One runtime row. One connection row. `Manage` on `Kortix` is where "set my
default model" lives (§8.3) — zero matrix, zero chips, zero fan-out
language, exactly the pristine common case the brief asks to protect.

**Wireframe — flag on, gateway-central, Codex subscription widened (target
state, dependent on the transport plan in §8.0):**

```text
Models                                                        [+ Connect]
Connect model services and choose what each agent runtime uses.

Agent runtimes
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude Code                              Connected                   │
│   Claude subscription · Harness default                      [Change ▾]│
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Codex                                    Connected                   │
│   ChatGPT subscription · Harness default                      [Change ▾]│
├────────────────────────────────────────────────────────────────────────┤
│ ◆ OpenCode                                 Connected                   │
│   ChatGPT subscription · Automatic                            [Change ▾]│
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Pi                                       Connected                   │
│   ChatGPT subscription · Harness default                      [Change ▾]│
└────────────────────────────────────────────────────────────────────────┘

Your connections
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude subscription                      Connected          [Manage] │
│   Used by Claude Code · Models managed by Claude Code                  │
│   Billed to your Claude subscription — not Kortix credits              │
├────────────────────────────────────────────────────────────────────────┤
│ [Subscription] ChatGPT / Codex              Connected          [Manage]│
│   Used by Codex, OpenCode, and Pi · Models managed by Codex            │
│   Billed to your ChatGPT subscription — not Kortix credits             │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ Kortix                                   Connected           [Manage]│
│   Included with Kortix · 12 models available                          │
│   Billed in Kortix credits                                             │
└────────────────────────────────────────────────────────────────────────┘
```

One credential (`ChatGPT / Codex`) visibly lights up three runtime rows and
appears exactly once in the connections list, with an explicit,
un-misreadable billing line. Claude's row shows no chips and no fan-out —
one harness, degrading gracefully exactly as §8.1 specifies, with no visual
signal that it is "missing" anything relative to Codex's row.

### 8.6 Open questions added by this round

5. **Does routing Claude Code's model requests through the gateway (custom
   base URL, token stays local) actually sidestep the ToS question, or does
   it not matter because Anthropic's terms govern token *usage* regardless of
   where inference is proxied?** §8.0 states my working assumption but this
   is a legal/ToS reading I am not positioned to make and the architecture
   agent's transport plan should settle before §8.1's Claude-side design
   (currently "pinned, degrades gracefully") is revisited.
6. **Is `active_for`/`usedBy` meant to become a real-time "this credential
   funded the last successful request" signal, or does it stay a
   preference/routing-intent field with a separate, new field added for
   actual billing provenance?** §8.4.4 assumes the former is required for
   the badge to be honest; if the fix instead adds a parallel field, the
   copy in §8.4.1/8.4.2 should read from that field specifically, not
   `active_for`.
7. **Where does the relocated `Default model` control in §8.3 leave a
   project that has the managed gateway *disabled* entirely** (self-host,
   `llm_gateway` flag off) — does `Manage` on a connection that doesn't
   exist need a different home, or does "set my default model" simply not
   apply to that configuration? Not resolved here; flagging because §8.3's
   "there is only one gateway connection to manage now" assumption breaks
   if the gateway itself is optional in some deployments, which
   `2026-07-14-provider-auth-model-management.md`'s existing `llm_gateway`
   flag suggests is still possible even in a "gateway is central" world.
