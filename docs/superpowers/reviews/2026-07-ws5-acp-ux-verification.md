# WS5 ACP UX — verification matrix + UI docs (Task WS5-P6-a)

**Date:** 2026-07-17 · **Branch:** `acp-harness-runtime-v2` (base `4380f4359`) · **Author:** Claude (env-free verification pass, per Jay's ENV SPLIT).

## Verdict

**Shippable (env-free scope): YES.** Every mechanical gate this checkout can run is
green: full web suite, `tsc`, the ACP design-guard, and the perf-budget test. Three
a11y findings were fixed in-tree with new regression tests; three more are precisely
measured/documented and **ledgered** — each needs either a design-token decision or a
real browser to close, not a code fix bounded to this task. **The live e2e/Playwright
wave (Part B) did not run** — this checkout has no `apps/web/.env.keys` /
`apps/api/.env.keys`, so the dev stack cannot boot. Nothing was forced; the exact
runbook + Jay-unblock list is below so the live wave can execute the moment the keys
land, without any further investigation.

This report only speaks for the **web unit-test suite and static source review**. It
does not claim live-browser, cross-harness, or light/dark visual proof — that is
explicitly Part B, and is called out as such throughout.

---

## What was verified this session (all fresh runs, this working tree)

| Gate | Result |
|---|---|
| `cd apps/web && bun test --isolate` | **1379 pass / 0 fail**, 156 files, 4080 `expect()` calls (baseline was 1371/0 before this task's 8 new a11y tests) |
| `cd apps/web && npx tsc --noEmit` | clean, exit 0 |
| `bun test src/features/session/design-guard.test.ts` | **57 pass / 0 fail** (unchanged — no design-token regressions introduced) |
| `bun test src/features/session/acp-session-perf.test.tsx` | **1 pass / 0 fail** — see perf detail below |

### Perf-budget detail (Task WS5-P6-a Step 3)

Instrumented a one-off `console.log` inside the perf test to pull the raw numbers,
then reverted it (the committed test is byte-identical to before this task — `git
diff` on the file is empty):

```
PERF_RESULT commits=141 budget=160 rows=2230 slow=0 maxDuration=6.123
```

- **Fixture:** `src/features/session/__fixtures__/acp-replay-session.json`, confirmed
  **2,230 rows** (`python3 -c "import json; print(len(json.load(open(...))))"`).
- **Budget law:** `ceil(rows/16)+20` = `ceil(2230/16)+20` = `140+20` = **160** commits max.
- **Actual:** **141 commits** — well inside budget.
- **Slow frames:** **0 commits > 16ms** (max observed commit `actualDuration` was
  **6.123ms**, comfortably under the 16ms/frame threshold).
- This is a `react-test-renderer` `Profiler.onRender` commit-duration measurement
  (jsdom-free harness, no real browser paint), not a Chrome DevTools frame trace —
  it is the same measurement the perf test has used since Task 19 and the number the
  WS5 plan's Global Constraint gate ("law: `ceil(rows/16)+20` commits, 0 frames
  >16ms") is written against. A real-browser frame trace (rAF-timestamp based) is a
  Part B item — see the runbook.

---

## Per-surface verification matrix

Legend: **MV** = machine-verified in this checkout (unit test or static source
review, this session) · **LIVE** = needs the Part B live/authed-browser wave · **N/A**
= not applicable to this surface.

### ModelPicker (`apps/web/src/features/session/model-picker/`)

| Check | Status | Evidence |
|---|---|---|
| Keyboard-only walk (Escape closes popover) | **MV** | New test: `model-picker.test.tsx` — "Escape closes the popover (Radix Popover dismissal, inherited)" |
| Keyboard-only walk (ArrowDown + Enter selects, no mouse) | **MV** | New test: "ArrowDown + Enter selects the highlighted row with no mouse click" — proves `cmdk`'s roving keyboard nav reaches `vm.select` |
| Trigger is a real focusable `<button type="button">` | **MV** | New test: "the trigger is a real `<button>` reachable by Tab, not a div with a click handler" |
| Focus-visible ring on trigger while tabbed to | **LEDGERED (L2)** | `COMPOSER_PILL_TRIGGER_CLASS` has no explicit `focus-visible:ring-*`; browser default outline still renders (no global `outline:none` reset exists), but it is visually inconsistent with `Button`/`Switch`'s `focus-visible:ring-kortix-base`. See Findings below. |
| Contrast — `Zap` live-swap hint icon (`text-kortix-yellow`) | **LEDGERED (L1)** | Computed: 2.38:1 in light theme (fails WCAG 1.4.11's 3:1 graphical-object minimum), 7.52:1 in dark theme (passes). See Findings below. |
| Selected-row screen-reader announcement (`Check` icon only, no `aria-current`) | **LEDGERED (L3)** | Inherited byte-for-byte from legacy `model-selector.tsx` — not a WS5 regression. |
| `prefers-reduced-motion` | **N/A** (no scale/blur transform on ModelPicker's own surfaces — only a 200ms `rotate-180` chevron state-toggle and Radix's own zoom-in-\[0.97\] popover entrance, both inherited from the shared `CommandPopoverContent`/`Button` primitives, not novel to this component) | Source review |
| Light/dark token compliance (no raw hex/amber/emerald, radius scale) | **MV** | `design-guard.test.ts` covers `src/features/session/model-picker/*.tsx` directly — 57/0 includes this directory |
| No harness fork — one list for every harness | **MV** | Existing test: "renders one model-first list — no harness fork" |
| Live cross-harness rendering (opencode/claude/codex/pi), light+dark screenshots | **LIVE** | Part B — `16-model-picker.spec.ts` |

### PermissionPrompt (`apps/web/src/features/session/permission-prompt/`)

| Check | Status | Evidence |
|---|---|---|
| `prefers-reduced-motion` — row-swap animation uses opacity only under reduce, no scale/blur transform | **MV (regression-locked)** | Exported `rowSwapVariants` (was module-private) + 3 new unit tests mirroring `acp-request-cards.tsx`'s `cardSwapVariants` precedent: reduced path is `{opacity}`-only, full path carries `scale`/`filter: blur(...)`, transition (`{type:'spring', duration:0.3, bounce:0}`) is identical either way |
| Action order (Deny → Allow once → Allow for session, left to right) | **MV** | Existing test: "renders Deny, then Allow once, then Allow for session, left to right" |
| Focus/tab order matches visual order | **MV** | Source review: no `tabIndex` overrides, no CSS `order-*` utilities anywhere in the file — DOM order (verified above) *is* tab order in a plain flex layout |
| "Allow everything" gated behind `ConfirmDialog` (`role="alertdialog"`) | **MV** | Existing test: "does not call onReply until the confirmation is accepted"; Radix `AlertDialog` (inherited) owns its own focus-trap/Escape/focus-return |
| `Switch` keyboard-operable, has `aria-label` | **MV** | Existing test uses `getByRole('switch', {name: 'Remember for this project'})`; Radix `Switch` (inherited) is a real `<button role="switch">`, Space/Enter-operable natively |
| Contrast — `ShieldAlert` icon (`text-kortix-yellow`) on `bg-kortix-yellow/15` tile | **LEDGERED (L1)** | Computed: **2.11:1** in light theme (fails 3:1), **5.85:1** in dark theme (passes). See Findings below. |
| Zero `amber-*` classes anywhere in the DOM | **MV** | Existing test: "never renders an amber-\* class anywhere in its DOM" |
| Token compliance (radius scale, no raw hex/emerald, no `transition-all`) | **MV (manual)** | `design-guard.test.ts`'s `DIRS` list does **not** include `src/features/session/permission-prompt/` (it only scans `src/features/session` top-level + `src/features/session/model-picker`) — manually grepped the guard's exact BANNED regex set against both files in this directory: **zero matches**, clean |
| Live permission flow across harnesses, light+dark, "Remember" persistence across a second request | **LIVE** | Part B — `15-acp-permission-flow.spec.ts` |

### Runtime section (`apps/web/src/features/workspace/customize/sections/view/runtime-view.tsx`)

| Check | Status | Evidence |
|---|---|---|
| `prefers-reduced-motion` — row entrance animation (`animate-in fade-in-0 slide-in-from-bottom-1`) | **FIXED + MV** | This was a real gap: the row stagger-in is a `translateY` transform CSS animation with **no** reduced-motion guard anywhere in the codebase (`tw-animate-css` ships none itself). Fixed in `globals.css` (see Findings F1 below) + 2 new source-content regression tests |
| Primary DOM carries no manifest jargon (`schema_version`, `kortix.yaml`, profile slugs, config-dir paths) | **MV** | Existing test: "primary DOM carries no manifest jargon…" |
| Advanced disclosure collapsed by default, reveals jargon on open | **MV** | Existing test |
| Banner links to a real Files route (not a dead end) | **MV** | Existing test: asserts `href` |
| First-run `EmptyState` for zero-runtime projects | **MV** | Existing tests (WS5-P5-a) |
| Guided connect→model flow (≤2 navigations) | **MV** | Existing tests (WS5-P2-b) |
| Row hit areas ≥40px (`min-h-10` on Connect/Choose model buttons) | **MV** | Source review: both buttons carry `min-h-10` (40px) |
| Token compliance (radius scale, no raw hex/amber/emerald, no `transition-all`) | **MV (manual)** | `design-guard.test.ts`'s `DIRS` does **not** cover `src/features/workspace/customize/sections/view/` — manually grepped the guard's exact BANNED regex set against `runtime-view.tsx`: **zero matches**, clean |
| Live cross-harness rows, connect flow, light+dark screenshots | **LIVE** | Part B — `17-runtime-flow.spec.ts` |

---

## a11y findings — fixed (3)

**F1 — Runtime row entrance animation ignored `prefers-reduced-motion` (real bug, fixed).**
`RuntimeEntityRow` (`runtime-view.tsx`) renders each row with
`animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both` — a `translateY`
transform CSS animation via `tw-animate-css`. Neither that library nor this
codebase's `globals.css` had any `@media (prefers-reduced-motion: reduce)` guard
for `tw-animate-css`'s `.animate-in`/`.animate-out` utilities, so a user with the OS
reduced-motion preference on still got a sliding entrance for every runtime row —
a direct violation of the WS5 design law ("no transform motion under reduce"). The
same unguarded utility combo is reused sitewide (`changes-view.tsx`,
`gateway/_metrics.tsx`, `running-services-panel.tsx`, `acp-session-chat.tsx`, the
`/design-system` demo page), so the most correct fix is the systemic one, not a
per-component patch: added a new `@media (prefers-reduced-motion: reduce)` block in
`apps/web/src/app/globals.css` (next to three pre-existing analogous guards for
`.animate-shake`/`.animate-spinner-*`, same convention) that zeroes
`tw-animate-css`'s `--tw-enter-translate-{x,y}`/`--tw-enter-scale`/
`--tw-enter-rotate`/`--tw-enter-blur` and the `--tw-exit-*` equivalents back to
their `@property` initial values for any `.animate-in`/`.animate-out` element,
leaving only the `fade-in-0`/`fade-out-*` opacity component. Purely additive CSS —
cannot affect any existing test (none of the 1371 baseline tests exercise
`prefers-reduced-motion: reduce`; the `window.matchMedia` stubs used across the
suite all return `matches: false`). Locked in with 2 new source-content regression
tests in `runtime-view.test.tsx` (one confirms the component still emits the exact
transform-driving class combo, the other confirms `globals.css` still neutralizes
it) — the same static-source-assertion technique `design-guard.test.ts` already
uses, chosen because this harness (`happy-dom`, no stylesheet loading) cannot
evaluate a real media query. **Not live-verified** — the actual computed rendering
under reduced-motion needs Part B's live browser.

**F2 — `PermissionPrompt`'s reduced-motion guard existed but was untested (regression-proofed, no behavior change).**
`rowSwapVariants` (the pending-prompt → answered-record row swap) already correctly
returned an opacity-only variant set under reduced motion — this was implemented
correctly in the original WS5-P1-c work, just not directly unit-tested (only
reachable indirectly through rendered `motion.div` props, which this DOM-free-ish
harness can't introspect reliably). Exported the function (was module-private) and
added 3 tests mirroring `acp-request-cards.tsx`'s existing `cardSwapVariants` test
precedent exactly, so a future edit that accidentally reintroduces `scale`/`filter`
into the reduced branch now fails a test instead of shipping silently.

**F3 — ModelPicker's keyboard-only path was correct but unverified (regression-proofed, no behavior change).**
`CommandPopover`/`CommandPopoverContent` (Radix `Popover` + `cmdk` `Command`) already
provide full keyboard semantics (Escape to dismiss, arrow-key roving highlight,
Enter to select) — inherited "for free" from well-established libraries used
identically elsewhere in the composer. No test proved these reached `ModelPicker`'s
own callbacks, though. Added 3 tests: Escape closes the popover; `ArrowDown` +
`Enter` fires `vm.select` with zero mouse interaction; the trigger is a real
`<button type="button">` (not a clickable `<div>`), so it is Tab-reachable and
Enter/Space-activatable by default.

## a11y findings — ledgered (3, not fixed here)

**L1 — `kortix-yellow` fails WCAG 1.4.11 (3:1 graphical-object minimum) in light theme, on both new surfaces.**
Computed via OKLCH→sRGB→WCAG-relative-luminance (the token:
`--kortix-yellow: oklch(0.732 0.15 90.688)`, identical value in both `:root` and
`.dark` — `globals.css:594`/`665`):

| Pairing | Light theme | Dark theme |
|---|---|---|
| `ShieldAlert` icon on `bg-kortix-yellow/15` tile (`permission-prompt.tsx`) | **2.11:1** (fails 3:1) | 5.85:1 (passes) |
| `Zap` live-swap hint icon, bare on card bg (`model-picker-row.tsx`) | **2.38:1** (fails 3:1) | 7.52:1 (passes) |

Dark theme is comfortably compliant both places; **light theme is not**. This is a
**token-level** issue, not a local styling mistake: `kortix-yellow`'s lightness
(`L=0.732`) is simply too high to clear 3:1 against a near-white background no
matter how it's composited, and the exact `bg-kortix-yellow/15` tinted-tile pattern
this permission tile uses is reused in 5 files across the app (`sandbox-view.tsx`,
`add-to-project-modal.tsx`, `marketplace-meta.tsx`, `acp-request-cards.tsx`, plus
this one) — not novel to WS5. A local patch in just these two files would create a
visible inconsistency with the other three. **Ledgered, not fixed**, because closing
it correctly needs a `better-colors`/`kortix-design-system` token review (a
darker/more-saturated light-mode `kortix-yellow`, or a separate stronger icon tone)
with live-browser confirmation across all 5 call sites — squarely a Part B /
design-system-owner decision, not a bounded code fix for this task.

**L2 — `COMPOSER_PILL_TRIGGER_CLASS` has no explicit `focus-visible` ring, unlike `Button`/`Switch`.**
`Button` and `Switch` both carry `focus-visible:ring-kortix-base
focus-visible:ring-[0.6px]`-style rings; the shared `COMPOSER_PILL_TRIGGER_CLASS`
constant (`composer-pill.ts`) that `ModelPicker`'s raw `<button>` trigger uses does
not. **Not a WCAG 2.4.7 failure** — confirmed no global `outline: none` reset exists
in `globals.css`'s base layer, so the browser's native focus outline still renders
on keyboard focus — but it is a visible design-consistency gap against the rest of
the app's polished ring styling. `COMPOSER_PILL_TRIGGER_CLASS` is shared by 4 other
pill triggers beyond `ModelPicker` (`session-chat-input.tsx`, `model-selector.tsx`,
`harness-model-selector.tsx`), so fixing it ripples past this task's 3-surface scope
and has no way to be visually confirmed correct in this stylesheet-free unit-test
harness. **Ledgered** for a Part B visual check before landing a shared-constant
change.

**L3 — Selected-model row conveys selection only visually (`Check` icon + bold text), no `aria-current`/hidden text for screen readers.**
`cmdk`'s own `aria-selected` already means "currently keyboard-highlighted", not
"this is the chosen value" — so it can't double for announcing which option in the
list is the active model selection. This is inherited **byte-for-byte** from the
legacy `model-selector.tsx` (identical `{isSelected && <Check .../>}` pattern at two
call sites there) — not a regression introduced by `ModelPicker`, a pre-existing
sitewide combobox pattern. Fixing it well (e.g. `aria-current="true"` or a
visually-hidden "(selected)" suffix) is a combobox-selection-announcement design
decision that should cover both pickers consistently, not a one-off patch to the
new component alone. **Ledgered.**

---

## UI notes for WS6 docs

Handing these off for whoever writes the user-facing/docs-workstream (WS6) material
on the ACP session UI:

- **Model selection is now one surface for every harness.** There is no more
  "catalog picker" vs "harness picker" fork to document separately — one popover,
  model-first, with harness/auth folded into a calm sublabel line. Docs should show
  a single screenshot/GIF, not per-harness variants.
- **Permission handling is one surface too**, and it now has a **persistent,
  project-scoped policy**: `autoApprove: 'none' | 'reads' | 'all'` plus a
  per-tool "remember this decision" switch. Docs should explain the policy is
  conservative-by-default (`none` = ask every time) and that `reads` deliberately
  excludes `webfetch` (network egress is treated as a mutation-adjacent risk, not a
  read) — this is a documented product decision, not an oversight, and worth calling
  out explicitly so users don't file it as a bug.
- **"Allow everything for this session"** is now a deliberate, confirmed action
  (`ConfirmDialog`), not a single click — docs/screenshots should show the
  confirmation step, not skip it.
- **The harness now has a home**: the "Runtime" section in Customize, with plain
  labels ("Claude Code", "Codex", …) and a connection badge, not manifest jargon.
  `schema_version`/`kortix.yaml`/profile slugs still exist for power users but live
  behind a single "Advanced" disclosure — docs for the *primary* flow should never
  mention them; a separate "Advanced: editing kortix.yaml directly" doc section can.
- **Guided connect→model flow**: from the Runtime section, a disconnected harness's
  "Connect" button opens a method picker pre-filtered to that harness's compatible
  auth kinds (no irrelevant ChatGPT/OpenAI options on a Claude row, etc.); once
  connected, the same row offers "Choose model", which is 1 click to the composer.
  Total: 2 navigations from "I want to use Codex" to "I've picked a Codex model" —
  good material for a short guided-tour doc/GIF.
- **Cost/usage is now always-visible**, not hover-only, on the last turn — worth a
  callout in whatever doc covers session cost tracking.
- **Known light-theme contrast debt (L1 above)**: if WS6 or marketing produces
  light-theme screenshots of the permission prompt or the model picker's live-swap
  hint, the yellow icon glyph will look a little washed out against light
  backgrounds — this is tracked (not new/surprising), not something to re-report.

---

## Part B — env-blocked live wave: runbook + Jay-unblock list

**Status: Blocked — env, not attempted.** Per the binding ENV SPLIT, this checkout
has no `apps/web/.env.keys` / `apps/api/.env.keys` and no `dotenvx-armor` CLI, so the
dev stack cannot be booted and the live/authed wave cannot run here. This mirrors the
identical blocker already recorded against `WS3-P4-a` in the cycle ledger. Nothing
was forced, and no secrets were hunted for.

### Exact Jay-unblock list

1. **`apps/api/.env.keys` + `apps/web/.env.keys`** — the dotenvx decryption keys for
   this worktree/branch. Without them, `apps/api/.env`/`apps/web/.env` (both
   dotenvx-encrypted in git per the `dotenvx-secrets` skill) cannot be decrypted, so
   the API/web dev servers cannot start with real config. The `dotenvx-armor` CLI
   (the tool that would normally fetch these from Dotenv Armor) is also not
   installed in this environment — copying the two `.env.keys` files in directly
   (same trick documented in repo memory for other worktrees) is the fastest path.
2. **Local Supabase provisioned with the `kortix` schema** — `pnpm dev` 503s without
   it (known local-dev footgun); needs `supabase db start` +
   `@kortix/db migrate` per repo memory, once the keys above let the stack boot at
   all.
3. **A real Anthropic API key** (`ANTHROPIC_API_KEY`) in the sandbox/session
   environment — `17-runtime-flow.spec.ts`'s header is explicit that it needs a real
   key to actually connect Claude and prove the guided flow end-to-end (not just
   reach the "Not connected" state). Optional `OPENAI_API_KEY` similarly widens
   `16-model-picker.spec.ts`'s Codex coverage.
4. **Node 22** for the worktree dev stack (per repo memory: `pnpm worktree start`
   defaults to a newer Node that this stack doesn't run cleanly on) — `nvm use 22`
   before booting.

### Runbook (execute in this exact order once #1-#4 land)

1. `nvm use 22`
2. Boot the worktree stack (`pnpm dev` from repo root, or the worktree-specific
   start script per the `worktree` skill) and confirm `apps/web`/`apps/api` come up
   without the `.env.keys`-missing errors this session hit.
3. Sign in via the worktree **auth-cookie trick** (repo memory: mint a session via
   the Supabase admin REST API, inject the port-scoped `sb-kortix-auth-token-<port>`
   cookie — magic-link email bounces to the wrong port otherwise).
4. **e2e 15/16/17, live, light theme:**
   ```
   cd tests
   E2E_BASE_URL=http://localhost:<web-port> E2E_API_URL=http://localhost:<api-port>/v1 \
     E2E_SUPABASE_URL=http://127.0.0.1:54321 \
     npx playwright test -c playwright.config.ts 15-acp-permission-flow 16-model-picker 17-runtime-flow
   ```
   All three specs currently carry header comments confirming they are
   "written and statically validated only" — **this would be their first live run.**
   Record pass/fail per spec in the cycle ledger (`WS5-P6-a` row).
5. **Dark theme repeat** — same three specs with the app's dark-theme toggle/cookie
   set before each spec's first `page.goto` (whatever mechanism the existing e2e
   suite uses elsewhere for theme — check `tests/e2e/helpers` for a precedent before
   inventing one).
6. **Per-harness matrix** — OpenCode is mandatory-green (default agent, no flag).
   For claude/codex/pi: flag the test project with `experimental_harnesses` (per
   `14-acp-harness-selector.spec.ts`'s pattern, already referenced in
   `16-model-picker.spec.ts`'s own header) and re-run 15/16/17 against each. Any
   harness lacking real creds (item 3 above) records `Blocked-with-reason: no
   <PROVIDER>_API_KEY` in the ledger — per the WS5-P6-a task's own acceptance
   criterion, that is an acceptable terminal state for this cycle, not a failure.
7. **Authed Playwright screenshot spot-check, light+dark** — permission prompt (mid
   a live permission request), model picker (open, showing a connected + a
   not-connected group), Runtime section (showing a connected + a not-connected
   row). This is the live counterpart to this report's static token-compliance
   checks (F1/L1/L2 above specifically need eyes-on confirmation).
8. **axe-core automated a11y scan** — `tests/accessibility/` already has a working
   `@axe-core/playwright` harness (`landing.a11y.spec.ts`, `blocking()`/
   `contrastNodeCount()` helpers, fails only on serious/critical). Add 3 authed
   specs targeting the three ACP surfaces (trigger a real permission request; open
   the model picker; open the Runtime section) using the exact same pattern — this
   is the direct, mechanical way to close out L1 with a real number instead of a
   manual OKLCH computation, and to catch anything this static/unit-test pass
   structurally cannot (real DOM post-hydration, real focus order across the whole
   page chrome, real screen-reader landmark structure).
9. **Real-browser frame trace for the perf claim** — this report's perf number
   (141/160 commits, 0 slow) is a `react-test-renderer` Profiler measurement, not a
   Chrome DevTools frame trace. If a stricter proof is wanted, record a
   `performance.now()`-based frame trace while scrolling the 2,230-row fixture
   session in a real browser tab and confirm 0 frames >16ms there too — optional,
   the unit-level number already satisfies the WS5 plan's stated law.
10. Update the cycle ledger's `WS5-P6-a` row to `Done` with the live results
    appended as Evidence, and flip **WS5 EXIT GATE** to fully closed.

---

## Files touched this session

- `apps/web/src/app/globals.css` — new reduced-motion guard for `tw-animate-css`'s
  `.animate-in`/`.animate-out` transform/blur custom properties (F1).
- `apps/web/src/features/session/permission-prompt/permission-prompt.tsx` — exported
  `rowSwapVariants` (no behavior change) (F2).
- `apps/web/src/features/session/permission-prompt/permission-prompt.test.tsx` — 3
  new tests locking in the reduced-motion branch of `rowSwapVariants`.
- `apps/web/src/features/session/model-picker/model-picker.test.tsx` — 3 new
  keyboard-only-walk tests.
- `apps/web/src/features/workspace/customize/sections/view/runtime-view.test.tsx` —
  2 new source-content regression tests for the reduced-motion guard.
- `docs/superpowers/reviews/2026-07-ws5-acp-ux-verification.md` — this report.
