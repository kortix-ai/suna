# OpenCode root config dir + model-connect UX — design

Status: draft, awaiting Jay's review
Date: 2026-07-20
Owner: Jay
Relation to prior work: builds on
`docs/superpowers/specs/2026-07-14-acp-sdk-hardening-web-ux-design.md` (its B1
covers the composer selector *internals* for live ACP sessions; this design
covers the model **connection** experience, picker consolidation, the
OpenCode runtime directory move, and — Part 3, added 2026-07-20 after
Jay expanded scope — the Models management surface (`gateway-view.tsx`)
and composer secondary-control coherence for a non-technical audience).

## Problems

1. **OpenCode is the odd harness out.** Every harness config dir is a root
   dotted dir (`.claude`, `.codex`, `.pi`) except OpenCode, which lives at
   `.kortix/opencode`. `.opencode` is also OpenCode's own native default, so
   the current layout is both inconsistent with our other harnesses and
   with OpenCode itself.
2. **Connecting a model is confusing.** Three visually different model
   pickers exist in parallel (`ModelSelector` 602 lines, gateway/OpenCode;
   `HarnessModelSelector` 280 lines, Claude/Codex/Pi; flag-gated unified
   `ModelPicker`). The "connect" CTA can land the user in a full 8-tab
   Customize panel, a project modal, or a global modal depending on route +
   gateway state. Connection state is derived two independent ways
   (`useModelsPage` vs. the composer's own `listProjectSecrets` scan). The
   Claude subscription flow asks the user to run a CLI command and paste a
   token with no guidance, right next to ChatGPT's one-click device OAuth.
   All of this hangs off a 2,732-line `session-chat-input.tsx`.
3. **The management surface is a developer console shown to consumers.**
   The Customize rail's "LLM" section (`gateway-view.tsx`) exposes 8 tabs —
   Providers, Routing, Playground, Overview, Logs, Budgets, API keys, API —
   to every user. The tab "Providers" opens a panel titled "Models". The
   Kortix managed gateway (the "it just works" path) appears as one
   connection row while the empty state says "No model services connected
   yet", implying setup is required. User copy leaks "gateway", "harness",
   "Agent runtimes", "endpoint", raw wire model ids in mono, and permission
   names ("manage-keys permission"). A dead deep-link (`llmProvidersTab` is
   accepted and ignored) means the composer's "manage models" intent
   silently no-ops. Overview/Budgets/Logs render all-zero dashboards on
   fetch error. In the composer, `VariantSelector` is a click-to-cycle
   button over OpenCode's legacy `variants` map — empty for every
   models.dev model, with a tooltip that lies ("Cycle thinking effort") —
   and `ReasoningEffortSelector` looks per-message but silently writes
   **project-wide** routing policy, says "auto" in the trigger but "Model
   default" in the popover for the same state, and hand-rolls the pill
   trigger class (as does `AcpConfigOptionPill`), drifting from
   `COMPOSER_PILL_TRIGGER_CLASS`. ACP config options are filtered to
   `type === 'select'` only, so a mode-typed harness option (e.g. a
   thinking mode) never renders.

## Goals

- OpenCode's default config dir becomes **`.opencode`** at repo root,
  matching the other harnesses, with zero breakage for existing projects.
- One model picker, one connect surface, one source of truth for "what's
  connected". A user can always answer: *what agent am I using, what model
  will it run, and where do I fix it if it can't run?*
- The whole experience reads for a **non-technical user** (~400k of them):
  the default Models surface says "you're set", developer tooling sits one
  level down, no jargon or raw wire ids outside developer surfaces, and
  the composer's pill row follows one coherent visual/interaction law.
- Kortix design system + polish checklists pass on every touched surface.

## Non-goals

- Live ACP session `configOptions` plumbing beyond the select/mode
  rendering in 3d (07-14 design, B1/Task 15 owns the rest).
- Mobile and whitelabel adoption of the redesigned surfaces.
- New auth methods or providers; the *internals* of Routing, Playground,
  Logs, Budgets, and the API reference (Part 3 regroups and standardizes
  their states; it does not redesign their content).
- Per-message reasoning effort (no wire exists; the project-scoped write
  path stays).

---

## Part 1 — OpenCode config dir → `.opencode`

### Decision

`HARNESSES.opencode.configDir` changes from `.kortix/opencode` to
`.opencode` in `packages/shared/src/harnesses.ts:93` — the canonical source
every package derives from. The independent hardcoded copies change with it
in the same slice:

| Site | What |
| --- | --- |
| `packages/registry/src/manifest.ts:13` | `DEFAULT_OPENCODE_CONFIG_DIR` |
| `packages/shared/src/sandbox/dockerfile-layer.ts` | warm-up staging, `OPENCODE_CONFIG_DIR` export, cleanup — all `.kortix/opencode` literals |
| `apps/api/src/snapshots/build-context.ts:51` + `apps/api/src/snapshots/dockerfile-layer.ts` | starter config staging path |
| `apps/cli/src/agents.ts`, `commands/init.ts`, `commands/skills.ts` | scaffold + symlink wiring |
| `packages/starter/scripts/write-managed-skills.ts:18` | skills prefix |
| `packages/starter/templates/**/.kortix/opencode/` (4 trees) | physically `git mv` to `.opencode/` |
| manifest-schema docs/examples, READMEs, web copy in `use-configure-thread.ts`, tests/fixtures/snapshots | mechanical updates |

`.kortix/` itself stays: it still holds `memory/` (the memory tool's data
root is an independent constant, confirmed uncoupled), `Dockerfile`,
`executor/`, etc. Only the OpenCode config subtree moves.

### Backward compatibility (the part that must not break)

Projects whose manifest **explicitly** names `.kortix/opencode` are safe —
the compiler reads `config_dir` from the manifest and only the *default*
changes. The exposure is legacy/no-manifest projects and default-dir
projects whose committed files still sit at `.kortix/opencode`.

**Legacy fallback rule** (applied at the two places that can see files):

> If the resolved OpenCode config dir does not contain `opencode.jsonc`
> and `.kortix/opencode/opencode.jsonc` exists, use `.kortix/opencode`.

- **Sandbox side:** `nativeConfigDir()` in
  `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts` applies the
  rule before emitting `OPENCODE_CONFIG_DIR`. This covers every existing
  sandbox/workspace, including warm images built before the change. The
  check is for `opencode.jsonc` presence (not bare dir existence) so an
  empty mkdir'd `.opencode` can't shadow real legacy config.
- **API side:** the git scanner (`apps/api/src/projects/git/config.ts`)
  applies the same rule when discovering runtime files, so
  `hasNativeConfig` / capabilities stay truthful for un-migrated repos.

No automatic `git mv` of user repos — we never mutate a user's tree. The
fallback keeps old projects working forever; new projects scaffold at
`.opencode`.

### CLI symlink rethink

`wireCodingAgents` currently symlinks `.opencode → .kortix/opencode`. After
the move `.opencode` **is** the real dir, so: drop the opencode symlink
entirely, and retarget `.claude` / `.agents` links to `.opencode`.
`handleExisting` gains one case: a legacy `.opencode` *symlink* pointing at
`.kortix/opencode` is replaced by nothing (the real dir), migrating
scaffolds cleanly on next `init`.

### Sequencing note

Snapshot/warm images must be rebuilt after merge for new-project staging to
land at `.opencode`; until rebuild, the sandbox fallback keeps old images
functional. The rendered-Dockerfile snapshot test updates in the same
change (never hand-edit `.snap` — re-run with snapshot update).

---

## Part 2 — model-connect UX redesign

### North star

Two pills in the composer: **Agent** and **Model**. One connect surface: a
single modal, reachable from anywhere in exactly one way. One source of
truth: `useModelsPage` (SDK). Management depth stays in Customize → Models;
the composer never dumps the user into an 8-tab panel.

### 2a. One picker: `ModelPicker` becomes the only picker

- Default `unified_model_picker` **on**; after a parity pass, delete the
  legacy fork in `session-chat-input.tsx:2559-2572` and retire
  `model-selector.tsx` + `harness-model-selector.tsx` (602 + 280 lines) in
  favor of `model-picker/` + `useModelPicker` (SDK VM already built to fold
  the catalog-vs-harness fork).
- The e2e contract is preserved by moving the testids
  (`data-testid="harness-model-selector"`, `agent-option`, `data-harness`)
  onto the unified components — `14-acp-harness-selector.spec.ts` keeps
  passing unmodified.
- Picker anatomy (design-system): `CommandPopover` at `shadow-md`,
  origin-aware, provider groups with `ProviderLogo`, human labels only (raw
  `modelID` never a primary label; sublabel only in search results),
  "Automatic" pinned row, activation switches preserved for gateway
  models, `Tag variant="free"` where applicable, one footer with
  "Set as default" + "Manage models".
- Harness-native agents (Claude/Codex subscriptions) show a **status row**
  ("Models managed by Claude Code — change with /model in session") instead
  of a fake list; presets + custom model input render only when
  capabilities allow (`model.custom_allowed`).

### 2b. Not-connected is a picker state, not a dead end

When the selected agent's harness has no usable connection:

- The Model pill renders in attention state: `text-kortix-orange` dot +
  label "Connect a model" (pill stays enabled).
- Opening it shows a **connect prompt inside the popover**: 2–4 provider
  rows (logo + name + one-line hint, e.g. "Claude subscription — Pro/Max")
  derived from the harness's `authKinds`, plus "More options…". Clicking
  any row opens the connect modal with that method preselected.
- `ModelConnectionBar` (the slide-out strip under the composer) keeps its
  job for hard-blocked sends but now always deep-links to the same modal.

### 2c. One connect surface

- `openConnectProvider()` in `use-model-connection-gate.tsx` loses its
  three-way branch (`Customize panel` / local modal / global modal). It
  always opens **the** connect modal via a single root-mounted host
  (global store, one instance under the app shell) — same modal in a
  project, outside a project, gateway on or off.
- The modal (`connect-model-modal.tsx`) keeps its two-level structure —
  method list → form — with a `< Back` header; it is never stacked inside
  `ProjectProviderModal` again (kills the modal-in-modal path).
- Customize → Models (`models-view.tsx`) remains the management surface
  (runtimes, connections, manage/disconnect) and opens the same root modal
  for "Connect".
- Method list is grouped and ranked for the current context: methods valid
  for the selected agent's harness first (from `HARNESSES[id].authKinds`),
  then everything else under "All providers" with search.

### 2d. Claude connect reaches parity with ChatGPT connect

`ClaudeSubscriptionForm` becomes a two-step guided flow in the same visual
shell as the ChatGPT device-OAuth form (`Stepper` pattern from
`dev-view.tsx`):

1. **Get a token** — copyable command block `claude setup-token` (copy
   button with the blur/scale icon-swap morph), one line of context, link
   to docs.
2. **Paste it** — password input with live shape validation, `Loading` on
   verify, `successToast` on connect; `UseWithRuntimes` checkboxes
   unchanged.

Same header/footer/spacing as the ChatGPT form so "subscription connect"
reads as one family. (True OAuth for Claude is out of scope — no public
device flow exists.)

### 2e. One source of truth for connection state

- The composer stops calling `listProjectSecrets` +
  `connectedGatewayProviderIdsFromSecretNames` directly. `useModelsPage`
  (SDK, `packages/sdk/src/react/use-models-page.ts`) grows
  `connectedProviderIds` in its projection; composer, picker, and gate all
  read it. One fetch, one derivation, no drift.
- The copy maps with "these must agree" comments (`CONNECTION_NAME`,
  `SUBSCRIPTION_COPY`, `NOT_EXPOSED_TEXT`, verb variants in
  `manage-connection-modal.tsx`) consolidate into `use-models-page.ts`,
  which already deliberately owns product copy. Components render, they
  don't name.
- The two "default model" surfaces collapse to one: the picker footer's
  "Set as default" stays; the extra `ModelSelector` floating in the LLM
  tab bar (`gateway-view.tsx:124`) leaves the tab chrome and becomes a
  labeled "Default model" row inside the Models landing view (see 3b) —
  one authority, now with context instead of an unlabeled picker.

### 2f. Composer surgery (scoped, not a rewrite)

Extract from `session-chat-input.tsx` (2,732 lines), mechanically and
without behavior change:

- `agent-selector.tsx` — the `AgentSelector` block (L259-485).
- `composer-model-controls.tsx` — the toolbar block that chooses/renders
  the picker + variant + reasoning-effort selectors (L2544-2586).

Agent selector polish (within the extraction): always group by harness
with group headers when >1 harness; each agent row shows harness badge +
a `size-1.5` status dot (`kortix-orange`) when that harness has no usable
connection; locked-in-session behavior unchanged; `Tab` cycling unchanged.

### 2g. Motion & polish (both parts)

animations.dev doctrine as codified in the 07-14 design: popovers
origin-aware, 150–200ms strong ease-out; icon swaps use scale 0.25→1 /
blur 4px→0 / spring `{ type: 'spring', duration: 0.3, bounce: 0 }`;
`AnimatePresence initial={false}`; pressed triggers `active:scale-[0.97]`;
`Loading` never `Loader2`; `Hint` never `Tooltip`; `Modal` never `Dialog`;
all state colors via `kortix-*` tokens; every dynamic count `tabular-nums`.

---

## Part 3 — Models surface & composer coherence

### 3a. Information architecture: 8 tabs → 3, rail says "Models"

Regrouping, not a Simple/Advanced toggle (a toggle is a second mode users
must discover) and not deletion (the developer surfaces are real — they
just don't belong at the top level). Every existing tab component stays
intact; only the bar and two thin wrappers change.

- Rail label `'LLM'` → **`'Models'`** (`customize-panel.tsx:46`) — also
  resolves the "tab says Providers, panel says Models" mismatch at the
  root.
- `gateway-view.tsx` `LLM_TABS` collapses to:

| Tab | Contains (existing components, unchanged internally) | Audience |
| --- | --- | --- |
| **Models** (default) | `ModelsView` | everyone |
| **Usage** | `GatewayOverview` / `GatewayLogs` / `GatewayBudgets` behind a `TabsListCompact` sub-row: Overview · Activity · Limits | owners/admins |
| **Developer** | `GatewayRouting`, `GatewayPlayground`, merged **API access** panel behind a sub-row: Routing · Playground · API access | developers |

- **API access** merges `GatewayKeys` (top) + `GatewayApiReference`
  (below) into one scrollable panel — kills the API-keys/API two-tab
  split and the `onViewModels` tab-hopping props.
- Sub-rows use `TabsListCompact`/`TabsTriggerCompact` so there is exactly
  one primary underline tab row on screen.
- `TAB_BY_SECTION` remaps (`llm-overview|llm-logs|llm-budgets` → Usage +
  sub-tab; `llm-keys|llm-api` → Developer + `api` sub-tab) so existing
  deep links keep working.
- **Dead plumbing deleted**: the ignored `llmProvidersTab` prop chain —
  store field + vestigial `LlmProvidersTab` type (`customize-store.ts:21`),
  the write in `use-model-connection-gate.tsx:110`, the forward in
  `gateway-view.tsx:150`. `llmProvidersConnect` (the working connect
  deep-link) stays.

### 3b. The landing view says "you're set"

`models-view.tsx` + `use-models-page.ts`, no new components:

- **Default model gets a home.** The `ModelSelector` currently floating
  unlabeled in the tab chrome becomes the first section of `ModelsView`:
  `Label` "Default model" + one `bg-popover rounded-md border px-4 py-3`
  row — plain-language description left ("Used when an agent doesn't pick
  its own"), selector right. Same `useModelDefaults` write path.
- **Kortix pinned first.** `connectionRank` in `use-models-page.ts` ranks
  a ready `managed_gateway` connection above in-use BYOK rows
  (needs-attention rows still outrank everything). The included path is
  the visible headline, not one row lost in a list.
- **Empty state flips from demand to reassurance.** With no user
  connections: title **"Kortix models are included"**, description
  **"Optionally connect a Claude or ChatGPT subscription, or your own API
  key, to use those instead."**, CTA stays "Connect". The old "No model
  services connected yet" framing appears only if the managed gateway
  itself is unavailable. Strings exported from `use-models-page.ts`
  (SDK owns connection copy; additive exports only).
- "Manage runtimes →" relabels to **"Manage agents →"** (the sanctioned
  `setSection` pattern stays; "runtimes" is internal vocabulary).

### 3c. Copy law and glossary

Rule: copy describing a **connection kind, runtime status, or
resolution** lives in `use-models-page.ts` (it already deliberately owns
this). Copy describing **chrome** — tab labels, headings, error titles —
lives in the host component. One registry, no "these must agree"
comments.

| Before (in UI today) | After |
| --- | --- |
| LLM (rail label) | Models |
| Providers (tab) | Models |
| "gateway" in user copy | dropped or "Kortix"; allowed one level down in Developer surfaces |
| raw wire model ids in `font-mono` | `displayModel()` names everywhere except Developer surfaces and copy-to-clipboard affordances |
| "You need the manage-keys permission…" | "API keys need admin access" / "Ask a project admin." |
| "No model services connected yet" | "Kortix models are included" (see 3b) |
| "Manage runtimes →" | "Manage agents →" |
| "Cycle thinking effort" | *(deleted with VariantSelector)* |
| "Reasoning effort" / trigger "auto" | "Thinking" / "Auto" (see 3d) |

### 3d. Composer pill row — one law

- **`VariantSelector` is deleted.** The OpenCode legacy per-model
  `variants` map is empty for every models.dev model, the click-to-cycle
  interaction is undiscoverable, and the tooltip mislabels it. Remove the
  component (`session-chat-input.tsx:493-535`), the
  `variants`/`selectedVariant`/`onVariantChange` prop threading, and the
  StartStash variant field. Real harness thinking modes arrive as ACP
  config options (below), not through this map.
- **Reasoning effort becomes the "Thinking" pill.** The project-scoped
  write path stays (it is the only wire that exists; per-message effort
  is YAGNI). Presentation: `Brain` icon + value on the shared pill
  classes; trigger shows **"Auto"** and the popover's first item reads
  **"Auto — model default"** (same word for the same state); popover
  footer (`border-t px-2 py-1.5 text-xs text-muted-foreground`) states
  the scope honestly in plain words — "Applies to {display name}
  everywhere in this project" — using `displayModel()`, never the mono
  wire id; locked state reads "Only editors can change this" via `Hint`.
- **Pill law** (written into `composer-pill.ts`'s doc comment, enforced
  by review): every composer pill imports `COMPOSER_PILL_TRIGGER_CLASS` /
  `ACTIVE` / `DISABLED` — no hand-rolled copies (today's stragglers:
  `ReasoningEffortSelector`, `AcpConfigOptionPill`); a pill that opens a
  popover shows the chevron, no chevron ⇔ not a popover, click-to-cycle
  is banned; leading icon only when the value alone is ambiguous; *hide*
  a pill when the capability doesn't apply to the model/harness, *disable
  with a `Hint`* when the capability applies but this user/state can't
  act.
- **ACP config options render both shapes.** Widen the filter at
  `acp-session-chat.tsx:482` from `type === 'select'` to
  `select || mode`. Select-typed → `AcpConfigOptionPill` (popover, shared
  classes). Mode-typed → new `AcpConfigOptionSegment`, a
  `TabsListCompact`/`TabsTriggerCompact` segmented control on the h-8
  pill baseline (the 07-14 design's B1 shape). Both extract into
  `apps/web/src/features/session/acp-config-option-pills.tsx` (they are
  currently inlined in the 1,000-line `acp-session-chat.tsx`).

### 3e. Error/loading states standardize on one pattern

The `agents-view.tsx` content-block flow everywhere in the Models
section: shape-matched `Skeleton` → `ErrorState size="sm"` + Retry →
`EmptyState size="sm"` → content.

- `gateway-overview.tsx`, `gateway-budgets.tsx`, `gateway-logs.tsx`: add
  the missing `isError` branches — no more silent all-zero dashboards
  presented as truth.
- `gateway-keys.tsx`: the bare permission-string error becomes
  `ErrorState` — 403 → "API keys need admin access" / "Ask a project
  admin." (no retry); anything else → "Couldn't load API keys" + Retry.
- `gateway-logs.tsx` skeletons: `rounded-2xl` → `rounded-md` (token law).

## Success criteria

- Fresh scaffold, fresh sandbox, and CLI `init` all produce/read
  `.opencode/`; an un-migrated legacy project still boots OpenCode with its
  `.kortix/opencode` config (fallback proven by test); full test suites
  green including re-rendered Dockerfile snapshot.
- Exactly one model-picker implementation and one connect modal remain;
  `openConnectProvider` has one behavior; composer derives connection
  state only from `useModelsPage`.
- The not-connected path is: pill → popover connect prompt → modal → form →
  connected, with the picker refreshing in place (no reload, no panel
  maze).
- e2e `14-acp-harness-selector.spec.ts` passes unmodified; new e2e covers
  the connect-from-picker path; web `tsc` + suites green.
- The Customize rail says "Models" and its landing view opens on
  reassurance ("Kortix models are included") with exactly 3 top-level
  tabs; deep links from `llm-*` sections still land correctly; the
  `llmProvidersTab` dead plumbing is gone.
- No raw wire model ids, no "gateway"/"harness"/"runtimes"/"endpoint",
  and no permission names in user copy outside Developer surfaces
  (proven by a copy-grep triage in the polish task).
- Every composer pill uses the shared `composer-pill.ts` constants;
  `VariantSelector` no longer exists; the Thinking pill names its state
  "Auto" consistently and states its project-wide scope in its popover;
  a mode-typed ACP config option renders as a segmented control.
- Usage/Developer tabs never render silent zeros on fetch error — every
  gateway tab has Skeleton/ErrorState/EmptyState coverage.

## Sequencing

1. **Part 1** (OpenCode dir) — independent, mechanical, ships first.
2. **2e** source-of-truth consolidation (SDK projection) — unblocks
   everything else, no visual change.
3. **2c** one connect surface + **2d** Claude form parity.
4. **3a/3b/3c** Models section restructure + landing view + copy (after
   2e for the `use-models-page.ts` exports; independent of picker work),
   with **3e** state standardization alongside.
5. **2a/2b** picker consolidation + not-connected state.
6. **2f** composer extraction + agent selector polish, then **3d** pill
   row coherence (after the legacy pickers are gone, so the pill sweep
   touches `session-chat-input.tsx` once), then **2g** polish pass + e2e.

Constraint: nothing is committed or pushed without Jay's explicit go-ahead,
including this spec and its plan.
