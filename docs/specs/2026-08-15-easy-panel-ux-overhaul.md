# Easy panel UX overhaul — Outputs, Context, and tool rendering for non-technical users

- **Date:** 2026-08-15
- **Status:** Draft — awaiting Jay's review
- **Surface:** `apps/web/src/features/session/action-panel/easy/` + `apps/web/src/features/session/tool/`
- **Plan:** `docs/plans/2026-08-15-easy-panel-ux-overhaul-plan.md`

## Problem statement

The Easy panel is the default session surface for everyone. Its Outputs and
Context cards work, but they are not final-ready:

1. The Context card is too complicated for a non-technical user. It renders
   pill badges, not a readable list.
2. Files the agent read are listed but dead. Clicking a "Files read" row does
   nothing. Clicking an Outputs row opens the full file viewer. The same click
   must behave the same way in both cards.
3. Skill runs, tasks (sub-agents), and to-dos render inconsistently in chat.
   Skills and tasks need the same disclosure treatment to-dos already have.
4. Memory activity is nearly invisible, and what is visible says only
   "Memory" with no detail.
5. Bash/Python command blocks read as raw terminal dumps.
6. The empty Context card promises nothing actionable. It should offer
   "add context" and "connect apps" paths (default connectors + view all).
7. Overall polish is below the Perplexity/ChatGPT bar for this panel class.

## Current state (verified in code)

### Panel structure

- `easy-panel.tsx:30` — a fixed column of three cards: `OutputsCard` (fill),
  `ContextCard` (shrink-0), `AppsCard` ("Preview", only when apps exist).
- `panel-card.tsx:99` — shared disclosure shell; empty state = soft art + one
  sentence; exactly one card may `fill` (pinned by `fill-and-scroll.test.ts`).
- `session-panel-provider.tsx:82-105` — exposes `files`, `context`, `apps`,
  `handleOpenOutput(output, siblings?, source?)`, `openDetail(detail)`,
  `openBrowser`, `openFiles`, `openAudit`, terminal controls.
- Detail opens in `DetailLayer` (`detail-view.tsx:448`): desktop slide-over
  inside the panel, mobile drawer. File rows open via
  `handleOpenOutput` → `FilePreview` (`file-preview.tsx:322`), which routes
  pdf/docx/pptx/xlsx/csv/sqlite/video/audio/image to rich renderers and the
  rest to `FileViewer` (markdown render, HTML/SVG preview+source, shiki code).

### Defects and gaps

| # | Defect | Evidence |
|---|---|---|
| D1 | Context "Files read" rows are inert — no handler, no button | `context-card.tsx:167-180` renders `<li className={ROW}>` with no `onClick` |
| D2 | `ContextItem` has no `path`; the read branch computes the path and discards it | `derive-panels.ts:70-80` (type), `derive-panels.ts:513-517` (drop) |
| D3 | Context renders rounded-full pill badges in a flex-wrap, not rows | `context-card.tsx:108-123` |
| D4 | Context empty state is passive copy only ("Track tools and referenced files…") | `context-card.tsx:103` |
| D5 | `SkillTool` is a one-line clickable row (`Skill • name`, "N files" badge); no disclosure, no description; click jumps straight to `SKILL.md` in the viewer | `skill-tool.tsx:27-92`; behavior pinned by `skill-tool.test.tsx` |
| D6 | `TaskTool` forces a modal (`SubSessionModal`); its inline `SubAgentActivity` children are dead code when a child session exists; `rightAccessory` (ExternalLink glyph) is accepted by `BasicToolProps` but never rendered | `task-tool.tsx:25-95`, `infrastructure.tsx` (`ToolHeaderRow`) |
| D7 | `MemoryTool` row title is just "Memory" — the subtitle is commented out (`memory-tool.tsx:181`), so no file, no command shows; `onSubtitleClick` wired but unreachable |
| D8 | Memory lookups (`memory_search`, `get_mem`) are `PLUMBING_TOOLS` (`turn/step-label.ts:31`) — dropped from chat by `mergeBurstSteps` and excluded from the Actions panel (`infrastructure.tsx:810-826`). Memory work is invisible |
| D9 | Bash `CommandBlock` is a raw mono dump: command pane + output pane + exit-code footer, 12px mono throughout; no plain-language framing for Easy-mode readers | `bash-tool.tsx:47-207` |
| D10 | Outputs rows are minimal (28px glyph + name + kind label); no grouping, no timestamps, sparse compared to the Perplexity Artifacts bar | `outputs-card.tsx:151-217` |
| D11 | No "add context / connect apps" affordance anywhere in the session panel; connectors live at `/projects/{id}/connectors` and via `openConnectorGate` but the panel never points there | `connector-required-notice.tsx:60`, `connector-gate-store.ts:34` |
| D12 | `todo_write` renders well (progress bar + stepper) — it is the model to copy, not a defect. Listed for reference | `todo-write-tool.tsx:20-70` |

### Already-good machinery to reuse (do not rebuild)

- `pathOutput(path)` (`easy-panel-logic.ts:81`) + provider consume at
  `session-panel-provider.tsx:641-648`: any bare path opens in the full
  viewer with nav, split, tracking. `read-tool`, `skill-tool`, `memory-tool`
  already ride it.
- `narration.ts` families + `humanizeToolName` — every tool already resolves
  to a family and a plain label. New context rows must reuse this, never a
  second table (governing rule at `derive-panels.ts:1-14`).
- `groupSteps` (`shared/group-steps.ts`) is shared by chat bursts and the
  panel — one grouping change lands on both surfaces.
- `Disclosure`, `Badge`, `EmptyState`, entity-row classes, tinted icon tiles
  (kortix-design-system). `ConnectorRequiredNotice` + `openConnectorGate`
  for in-place connect flows.

## Design direction

References (Mobbin, reviewed 2026-08-15):

- **Perplexity Artifacts** — list rows with a type label ("Generated Image",
  "Document"), name, and relative time; grid view with thumbnails; kind
  filters. Target feel for Outputs.
- **Perplexity Space rail** — labelled sections (Files / Skills / Links) each
  with a quiet "+ Add …" affordance. Target feel for the Context empty/footer
  CTA.
- **ChatGPT Activity/Sources panel** — a chronological plain-language feed
  ("Searched for …", "Read reuters.com") with favicons; a Sources tab with
  count. Target feel for the Context detail views.

Kortix rules that bound the design (kortix-design-system):

- Rows, not pills: `<ul className="space-y-*">` entity rows with an icon,
  a `text-sm` label, and `text-xs` meta. `rounded-full` chips are for badges
  only.
- Tinted icon tiles for status; `kortix-*` tokens only; `rounded-md`
  surfaces; `Loading` is the only spinner; Phosphor icons without `weight`.
- Motion: 150–250 ms ease-out, crossfade icon swaps with blur+scale+opacity,
  `active:scale-[0.96–0.98]` press feedback, stagger ≤ 80 ms.

## Proposed changes

### W1 — Context card: rows instead of pills

Replace the badge wrap with a flat row list, one row per group, in a stable
order: Web sources, Files read, then each tool family:

```
[globe]  Web sources                       12  ›
[file]   Files read                         5  ›
[brain]  Memory                             2  ›
[spark]  Skills used                        3  ›
```

- Row anatomy: family icon (StepIcon, error state preserved), `text-sm`
  label, `Badge size="sm"` count right-aligned, chevron affordance.
- Row press opens the same `DetailLayer` the pills open today (no behavior
  regression), with press feedback per the polish doctrine.
- Labels stay plain-language via `humanizeToolName` / narration families —
  never raw tool ids.

### W2 — Files read: click opens the file

- Carry `path` on `ContextItem` for `kind: 'file'` (D2).
- `FileList` rows become buttons calling
  `handleOpenOutput(pathOutput(path), siblings)` so a read file opens in the
  exact viewer an output opens in, with prev/next nav across the read set.
- Rows get the real per-extension glyph (`getFileIcon`), matching Outputs.

### W3 — Context detail: source-quality views

- Web sources detail keeps favicon + title + URL (already good), gains the
  ChatGPT-style framing: count in header, rows open in a new tab.
- Tool details keep `ToolParts` truth but arrive with a one-line
  plain-language summary header (narration sentence) before the raw view.

### W4 — Context empty state + "connect apps" CTA

- Empty Context card gains two quiet actions under the promise copy:
  - **Add context** — focuses the composer attach/mention flow (existing
    paperclip + `@` file mention).
  - **Connect apps** — shows 3–4 default connectors (icons + one-line value)
    plus **View all** → `/projects/{projectId}/connectors`; individual
    connect uses `openConnectorGate` in place, no navigation.
- Non-empty Context keeps a single quiet footer row: `+ Connect apps`.

### W5 — Outputs card polish (Perplexity-artifact bar)

- Row upgrade: thumbnail (images already have one) or type tile, title,
  type label, and freshness — tightened to the reference rhythm.
- Optional grouping by kind when a run produces > ~10 mixed outputs
  (Documents / Images / Apps …), folded behind the existing
  "N more files" pattern; deliverable-first sort is preserved.
- Empty state gains one line of "what will appear here" plus nothing
  technical (unchanged contract).

### W6 — Skill rendering: disclosure like to-dos

- `SkillTool` becomes a disclosure row: icon + skill name +
  one-line purpose (from frontmatter description when available), body =
  what the skill loaded (files list) with the doc still one click away
  (`openPreview(SKILL.md)` moves to a body action, not the row click).
- Multiple skills in a burst keep the existing "Used N skills" group; each
  child is the new disclosure row.
- The pinned test contract (`skill-tool.test.tsx`: named skill = plain row
  that opens the panel) is updated deliberately as part of this change —
  the new contract is "named skill = disclosure row with doc action".

### W7 — Task (sub-agent) rendering: disclosure like to-dos

- `TaskTool` becomes a disclosure row: agent type + live last-activity
  subtitle + "N steps" badge; body = `SubAgentActivity` (already built,
  currently dead); a real, rendered "open full view" action replaces the
  never-rendered `rightAccessory` and opens `SubSessionModal`.

### W8 — Memory feel

- Restore `MemoryTool`'s subtitle (command + file), title becomes
  action-specific: "Memory updated" / "Memory read" via narration.
- Memory surfaces in the Context card as its own family row ("Memory", count
  of updates/reads) with the same detail treatment.
- Chat: memory *updates* (create/insert/str_replace/rename/delete) stop
  being invisible; lookups (`memory_search`, `get_mem`) may stay plumbing.

### W9 — Command block polish

- Keep the truth (command, output, exit code) but frame it: plain-language
  title from narration ("Installed dependencies", falling back to
  "Ran command"), calmer container per design-system (bg-popover, rounded-md,
  one border), tightened type rhythm, copy affordances kept.
- Panel surface keeps uncapped scroll; inline caps unchanged.

### W10 — Motion + consistency pass

- One review pass over the whole panel against make-interfaces-feel-better:
  concentric radii, press feedback, icon crossfades, stagger on card lists,
  tabular-nums on all counts, hit areas ≥ 40px on mobile rows.

## Non-goals

- No new data sources: everything derives from the existing `ToolPart[]`
  (`derive-panels.ts` governing rule stands).
- No Advanced-mode changes.
- No change to the one-fill-card layout law or the detail-layer motion
  contracts (`fill-and-scroll.test.ts`, `detail-view.test.tsx` stay green
  unmodified).
- No second transport/logic in hosts — panel stays SDK-fed via the provider.

## Constraints (tests that pin current behavior)

- `tool/tools/conformance.test.ts` — grammar contract for every tool view:
  no `rounded-2xl`, no stock shadows, no gradients, no raw palette colors,
  no literal "Loading...". All new renderers must pass.
- `skill-tool.test.tsx`, `bash-tool.test.tsx`, `web-search-tool.test.tsx` —
  pinned contracts; W6/W9 change them deliberately and must update the tests
  in the same commit with the new contract stated.
- `easy/*.test.*` — fill/scroll law, outputs row rules, snapshot collapse,
  detail dialog semantics: unchanged.
- `group-steps.test.ts` + `narration.test.ts` — shared by chat and panel;
  any grouping change must keep both surfaces coherent.

## Acceptance criteria

1. Clicking any "Files read" row opens that file in the detail viewer with
   prev/next across the read set (desktop + mobile drawer).
2. Context card renders zero `rounded-full` group chips; groups are rows
   with icon, label, count; every row opens a detail.
3. Empty Context card shows "Add context" and "Connect apps"; "View all"
   lands on `/projects/{id}/connectors`; a default connector connects via
   the gate without leaving the session.
4. A skill call renders as a disclosure row with name + purpose; its doc
   opens from the body action.
5. A task call renders as a disclosure row whose body shows live sub-agent
   activity; full view opens the modal.
6. A memory update is visible in chat and in the Context card, labelled in
   plain language with the file/command visible.
7. Bash blocks show a plain-language title; visual container matches the
   design system; copy/exit-code behavior unchanged.
8. `pnpm test` easy-panel + tool suites green; `tsc --noEmit` and eslint
   clean on touched files; conformance test green.
9. Screenshots (light + dark) of: full panel home, context detail, empty
   context with CTAs, skill/task/memory/bash rows — reviewed against the
   design-system references before merge.
