# Plan — Activity Burst: step-count title, failure honesty, file chips

Spec: `docs/superpowers/specs/2026-08-09-activity-burst-steps.md`
Branch: `activity-burst`

Five tasks. T1 and T2 touch only new files and run in parallel. T3 is the wiring
and depends on both. T4 is the gate. T5 is an adversarial read.

---

## T1 — `turn/burst-summary.ts` + `burst-summary.test.ts` (new files only)

Write the pure module. No React import — this module is unit-tested in isolation,
same as `burst-title.ts`, `step-label.ts`, and `merge-steps.ts`.

```ts
import { partOutcome } from '@/features/session/tool/shared/infrastructure';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import { stepLabel } from './step-label';

export interface BurstSummary { total: number; failed: number; completed: number }
export function burstSummary(parts: ReadonlyArray<Part>): BurstSummary
export function burstSummaryLabel(summary: BurstSummary, running: boolean): string
```

`burstSummary` counting, in one pass, mirroring `mergeBurstSteps` exactly:

- skip `stepLabel(part).tier === 'plumbing'` — never counted, and it must NOT
  break a reasoning run around it;
- a reasoning part with non-empty trimmed `text` opens a run; consecutive ones
  extend it; the run contributes `1` when it closes;
- a reasoning part with empty text contributes nothing and does not close a run;
- any other part contributes `1`;
- `failed` = tool parts where `stepLabel(part).tier !== 'plumbing'` and
  `partOutcome(part) !== 'ok'` — identical predicate to the existing
  `burstFailureCount`, which T3 replaces with this;
- `completed = total - failed`.

`burstSummaryLabel` implements the spec's wording table verbatim. It cannot see
`parts`, so the two `total === 0` settled cases (`Housekeeping` / `Worked`) need a
discriminator: add `hasPlumbing: boolean` to `BurstSummary` and set it in
`burstSummary`. Keep the field, do not add a second argument.

Tests (`bun:test`, `describe`/`test`, factories copied from `burst-title.test.ts`):

- 3 reads → `{ total: 3, failed: 0 }` → `Completed 3 steps`
- 1 read → `Completed 1 step` (singular)
- 4 consecutive reasoning fragments + 2 reads → `total: 3`
- reasoning, read, reasoning → `total: 4` (two runs, not one)
- an empty-text reasoning part between two reasoning parts does not split the run
- a plumbing tool between two reasoning parts does not split the run
- plumbing tools are not counted and do not appear in `failed`
- 11 reads, 1 errored → `Completed 10 of 11 steps · 1 failed`
- 2 tools, both errored → `2 steps failed`
- 1 tool, errored → `1 step failed`
- running with 4 steps → `Working · 4 steps`; running with 0 → `Working`
- settled, only plumbing → `Housekeeping`; settled, empty → `Worked`

**Do not touch any other file.**

---

## T2 — `turn/activity-file-chips.tsx` (new file only)

Two exports.

```tsx
export function isFileChipPart(part: Part): boolean
export function ActivityFileChipStep({ parts, running, sessionId, disableNavigation }: {...})
```

`isFileChipPart` — true when `isToolPart(part)` and
`normalizeActivityToolName(part.tool)` is `read` or `write`. Import
`normalizeActivityToolName` from `../session-activity-groups` (the same import
`activity-step.tsx` and `step-label.ts` use).

`ActivityFileChipStep` renders the row described in spec §2.2:

- reads the family from `parts[0]` — all parts in a run share a tool name, so
  `read`/`write` decides icon and verb. Derive the label from the count:
  `Read 3 files` / `Read 1 file` / `Wrote 2 files`, running → `Reading` / `Writing`.
- `status`: `error` if any part's `partOutcome(part) !== 'ok'`; `running` if any
  part's `state.status` is `pending`/`running`; else `done`.
- Trigger markup is a **copy of `ActivityGroupStep`'s trigger** — same
  `DisclosureTrigger` single-child rule, same `data-status`, same failure-glyph
  swap on `group-data-[state=open]/step:`, same `TextShimmer` when running, same
  caret. Do not refactor `ActivityGroupStep` to share it; the two triggers are
  four lines of JSX apart and a premature shared component would obscure the one
  place they differ (the body).
- Body: `<div className="mt-3 pl-7">` holding
  `<ul className="flex flex-wrap gap-2">` of chips, then, if any part failed, a
  `<div className="mt-3 space-y-3">` of `ActivityStep` rows for the failed parts
  only.
- Path extraction: `(part.state as {input?: Record<string, unknown>})?.input` then
  `filePath ?? path ?? file`, string and non-empty. Also try the streaming input
  the same way `read-tool.tsx` does if `partStreamingInput` is cheap to reach;
  if not, skip it — a path-less part falls back to an `ActivityStep` row.
- Dedupe by path, preserving first-seen order.

Chip visuals: exactly the spec's token list. `getFileIcon`, `getFileType`,
`getTypeLabel`, `getFilename` all come from `@/lib/utils/file-utils`. Click calls
`useFilePreviewStore((s) => s.openPreview)`.

Add `activity-file-chips.test.tsx`:
- `renderToStaticMarkup` of a 3-read run contains `Read 3 files`, all three
  basenames, and the type labels;
- a run of 1 read renders `Read 1 file` and one chip;
- the same path read twice renders one chip;
- a read with no path renders no chip;
- `isFileChipPart` is true for `read`/`write`, false for `edit`, `apply_patch`,
  `bash`, and reasoning.

Follow `activity-burst.test.tsx` for the provider wrapper
(`QueryClientProvider` + `NextIntlClientProvider`) if rendering needs it.

**Do not touch any other file.**

---

## T3 — Wire it into `activity-burst.tsx` (+ its test)

Depends on T1 and T2.

1. Replace `burstFailureCount`'s body with a delegate to `burstSummary(parts).failed`
   — keep the export and its doc comment, `tool-outcome.null-guard.test.ts` and
   `activity-burst.test.tsx` both import it.
2. Drop `import { burstTitle }`; add `burstSummary` / `burstSummaryLabel`.
   `const summary = useMemo(() => burstSummary(parts), [parts])`,
   `const title = burstSummaryLabel(running ? { ...summary, failed: 0, completed: summary.total } : summary, running)`.
   Simpler: keep the existing "failures are 0 while running" rule inside
   `burstSummaryLabel` by ignoring `failed` when `running` is true, and pass the
   summary through unchanged. Pick the second — one rule, one place.
3. Wrap the trigger title in `TextShimmer` when `running`, plain `<span>` otherwise.
4. In the `DisclosureContent` map:
   - `step.kind === 'group'` and every `step.step.parts` satisfies `isFileChipPart`
     and they share one tool name → `<ActivityFileChipStep parts={step.step.parts} …/>`;
   - `step.kind === 'part'` and `isFileChipPart(step.part)` → the same component
     with `parts={[step.part]}`;
   - everything else unchanged.
5. `ActivityGroupStep`'s content: `mt-2 space-y-2 pl-7` → `mt-3 space-y-3 pl-7`.
6. Delete `turn/burst-title.ts` and `turn/burst-title.test.ts`. Remove the one
   `burstTitle` assertion from `merge-steps.test.ts` (line ~182) and the stale
   `burstTitle` mentions in the `burstFailureCount` doc comment and the
   `activity-burst.test.tsx` comment at line ~346 — rewrite them to name
   `burstSummary` instead of leaving a dangling reference.

Update `activity-burst.test.tsx`: add cases asserting the trigger text for a
3-step burst, a `10 of 11` burst, an all-failed burst, and a running burst; assert
a read run renders a chip rather than a `BasicTool` trigger.

---

## T4 — Gate

Run and paste real output:

```
cd apps/web && bun test src/features/session/turn/
cd apps/web && npx tsc --noEmit
cd apps/web && npx eslint src/features/session/turn/activity-burst.tsx \
  src/features/session/turn/burst-summary.ts \
  src/features/session/turn/burst-summary.test.ts \
  src/features/session/turn/activity-file-chips.tsx \
  src/features/session/turn/activity-file-chips.test.tsx
```

Also `bun test src/features/session/tool/shared/tool-outcome.null-guard.test.ts`
— it exercises `burstFailureCount` against a null-state part and must stay green
after the delegation change.

`tsc` is expected to report only the 15 known `@types/bun` `test.each` errors in
`app/(system)/api/og/template/template-url.test.ts`,
`features/file-viewer/preview-fit.test.tsx`, and
`features/session/action-panel/easy/easy-panel-logic.test.ts`. Anything else is a
real failure.

---

## T5 — Adversarial review

Read the diff against the spec and answer, with file:line evidence:

1. Can `burstSummary().total` ever disagree with the number of units
   `mergeBurstSteps` renders? Name the input that breaks it or state that none does.
2. Can the title claim `Completed N` for a burst whose body shows a failure the
   reader cannot find?
3. Does any chip open something other than the right-hand file preview?
4. Does the chip row change behaviour for `edit` / `apply_patch`? It must not.
5. Is the destructive tint the only failure signal anywhere, or does shape/word
   carry it too?
6. Any `space-y-2` left in the burst body.
