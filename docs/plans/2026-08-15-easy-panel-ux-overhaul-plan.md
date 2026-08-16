# Easy panel UX overhaul — implementation plan

- **Spec:** `docs/specs/2026-08-15-easy-panel-ux-overhaul.md`
- **Date:** 2026-08-15
- **Working checkout:** `/Users/jay/root/kortix/suna-easy-panel` (branch `easy-panel`, currently at parity with `main`)
- **Delivery:** one PR per phase against `main`; local gates per task; screenshot review before each merge.

Each task lists: scope — verification. Verification commands run from repo
root unless noted. UI tasks additionally produce light+dark screenshots of
the touched surface.

## Phase 1 — Context card becomes a list (spec W1, W2, W3)

1. **Carry `path` on file `ContextItem`s.**
   Scope: `derive-panels.ts` — add `path?: string` to `ContextItem`; keep the
   path the `read` branch already computes (today discarded at the
   `files.push` site). No UI change.
   Verify: new unit case in `derive-panels.test.ts` asserting a read part
   yields `{kind:'file', path}`.

2. **Context groups render as rows, not pills.**
   Scope: `context-card.tsx` — replace the flex-wrap badge buttons with a
   `space-y`-list of full-width rows (StepIcon, `text-sm` label,
   `Badge size="sm"` count, chevron), stable order: web, files, tools.
   Press feedback + hit area per polish doctrine. Detail opening unchanged.
   Verify: `bun test context-card` (new test: renders no `rounded-full`
   group control; each row is a button that calls `onOpenDetail`);
   `easy/fill-and-scroll.test.ts` stays green (card stays `shrink-0`).

3. **"Files read" rows open the file viewer.**
   Scope: `context-card.tsx` `FileList` → buttons; thread
   `handleOpenOutput` + `pathOutput` (provider already consumes bare paths);
   per-extension glyph via `getFileIcon`; prev/next nav across the read set
   via the existing `siblings` mechanism.
   Verify: unit test — clicking a file row calls the open funnel with the
   part's path; manual: open a session with reads, click through, confirm
   viewer + nav on desktop and the mobile drawer.

4. **Tool detail gets a plain-language header.**
   Scope: `detail-view.tsx` `ToolParts` — one-line narration sentence above
   the raw tool views for context-tool details.
   Verify: unit test on the header line; existing `collapse-snapshots`
   behavior untouched.

## Phase 2 — Context empty state + connect apps (spec W4)

5. **Empty-state actions: Add context / Connect apps.**
   Scope: `context-card.tsx` empty branch — two quiet `Button
   variant="outline" size="sm"` actions under the promise copy. "Add
   context" focuses the composer attach flow; "Connect apps" expands the
   connector strip (task 6).
   Verify: unit test both buttons render only when empty; composer focus
   asserted via callback.

6. **Default-connector strip + View all.**
   Scope: new `connect-apps-strip.tsx` under `easy/` — 3–4 default
   connectors (icon, name, one-line value, Connect via
   `openConnectorGate({projectId, …})`), plus "View all" →
   `/projects/{projectId}/connectors`. `projectId` from the provider.
   Verify: unit test — gate store called with projectId; link href exact;
   manual connect flow against local stack.

7. **Non-empty footer affordance.**
   Scope: single quiet `+ Connect apps` row at the card foot when context
   exists; same strip behind it.
   Verify: unit test visibility rules (never doubles with the empty state).

## Phase 3 — Outputs card polish (spec W5)

8. **Row rhythm to the artifact-bar reference.**
   Scope: `outputs-card.tsx` — type label + freshness alignment, thumbnail
   sizing, spacing per design-system cheat sheet; keep deliverable-first
   sort, fold, download-all.
   Verify: `outputs-card.test.tsx` updated where the contract deliberately
   changes; screenshots vs current build.

9. **Kind grouping for large mixed runs.**
   Scope: pure helper in `easy-panel-logic.ts` (`groupOutputsByKind`,
   threshold ~10 mixed kinds) + rendering behind the existing fold.
   Verify: unit tests on the helper (threshold, ordering, single-kind runs
   never group); fold behavior tests stay green.

## Phase 4 — Tool renderer upgrades (spec W6–W9)

10. **SkillTool → disclosure row.**
    Scope: `skill-tool.tsx` — disclosure with name + purpose subtitle
    (frontmatter description when parsable from output), body = files
    loaded + "Open skill doc" action (existing `openPreview` funnel).
    Verify: rewrite `skill-tool.test.tsx` to the new contract in the same
    commit; conformance test green.

11. **TaskTool → disclosure row with live activity.**
    Scope: `task-tool.tsx` — disclosure; body = `SubAgentActivity`
    (currently dead); rendered "Open full view" action → `SubSessionModal`;
    delete the never-rendered `rightAccessory` path or make
    `ToolHeaderRow` render it — one or the other, not both.
    Verify: unit test — body renders activity; action opens modal;
    conformance green.

12. **Memory visibility + labels.**
    Scope: `memory-tool.tsx` — restore subtitle (command + file),
    action-specific titles via narration; `turn/step-label.ts` — memory
    *updates* leave `PLUMBING_TOOLS` (lookups stay); `derive-panels.ts` —
    memory family surfaces as a Context row.
    Verify: `merge-steps.test.ts` updated (updates visible, lookups
    dropped); narration test for the new sentences; context-card test for
    the memory row.

13. **CommandBlock reframe.**
    Scope: `bash-tool.tsx` — plain-language title from narration when
    derivable ("Ran command" fallback), container/type rhythm per
    design-system; keep copy buttons, exit-code footer, independent
    scroll, inline caps, panel uncapping.
    Verify: `bash-tool.test.tsx` updated where contracts change (left-edge
    alignment, floating copy, 12px command, failure wording stay pinned);
    conformance green.

## Phase 5 — Polish pass + verification (spec W10)

14. **make-interfaces-feel-better sweep over the panel.**
    Scope: radii concentricity, press states, icon crossfades
    (blur+scale+opacity spring), stagger on card lists, tabular-nums,
    ≥40px mobile hit areas; before/after table in the PR.
    Verify: eslint + `tsc --noEmit` clean on touched files; reduced-motion
    honored (existing `useReducedMotion` paths).

15. **Full gate + screenshot review.**
    Scope: none (verification task).
    Verify: `pnpm test -- --id` for the touched flows or targeted
    `bun test` suites for `easy/` + `tool/`; light+dark screenshots of the
    nine acceptance surfaces in the spec; deploy-to-dev check per
    repo delivery standard when merging.

## Risks

- Pinned test contracts (`skill-tool`, `bash-tool`, outputs) change on
  purpose — each change lands with its updated test and one-line rationale,
  never a silently weakened assertion.
- `group-steps`/narration edits touch chat bursts too — run
  `turn/` suites (`burst-summary`, `merge-steps`) on every Phase 4 commit.
- `PLUMBING_TOOLS` change (task 12) alters chat density for all users —
  scope strictly to memory update commands.
- Connector strip must not regress the panel's zero-data-source rule: it
  reads connector state via existing stores/SDK hooks only.
