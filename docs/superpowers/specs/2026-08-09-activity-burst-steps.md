# Spec — Activity Burst: step-count title, failure honesty, file chips

Date: 2026-08-09
Surface: `apps/web/src/features/session/turn/` (assistant turn chain of thought)
Branch: `activity-burst`

## 1. The problem

`ActivityBurst` collapses to a single summary line. Today that line is produced by
`burstTitle(parts, running)`, whose first resolution rule is "use a reasoning
summary". So the collapsed row reads as the model's own thought heading —
`Setting up the SCREAMSHEET project structure`.

Three things are wrong with that:

1. **It is a thought, not a summary of the burst.** The row is the door to a list
   of N steps. Labelling that door with one sentence pulled out of one of those
   steps tells the reader nothing about size, and the sentence is model-authored
   prose whose quality we do not control.
2. **It hides scale.** A burst of 3 steps and a burst of 37 steps look identical
   when collapsed. Perplexity and every peer surface answer this with a count.
3. **Failure is a glyph only.** A settled burst auto-collapses. If one of eleven
   calls failed, the only closed-state signal is a 14px warning icon. The words
   still claim a clean run.

Two smaller problems, same surface:

4. **`read` / `write` rows are tool cards, not files.** A read renders
   `BasicTool` — an inline disclosure that expands into a code viewer inside the
   chat column. The user already has a first-class file surface: the user-message
   attachment tile, which opens the file in the right-hand detail panel
   (`useFilePreviewStore.openPreview` → `openFileInSessionPanel`). A file the
   agent read should look and behave like a file the user attached.
5. **The expanded group list is cramped.** Group members sit at `space-y-2`.

## 2. What we build

### 2.1 The collapsed title is a step count

`burstTitle` is retired as the trigger label. A new pure module
`turn/burst-summary.ts` owns both the arithmetic and the words.

```ts
export interface BurstSummary {
  /** Every row-worthy unit in this burst. */
  total: number;
  /** Tool calls whose outcome is not `ok`. */
  failed: number;
  /** total - failed. */
  completed: number;
}
export function burstSummary(parts: ReadonlyArray<Part>): BurstSummary;
export function burstSummaryLabel(summary: BurstSummary, running: boolean): string;
```

**Counting rule for `total` — it MUST equal what the expanded chain renders.**
The burst already has three readers that must agree (the title, `mergeBurstSteps`,
and `burstFailureCount`); a fourth that disagrees is the bug this spec exists to
avoid repeating. So:

- every non-plumbing tool part counts `1` (plumbing = `stepLabel(part).tier === 'plumbing'`);
- every **run** of consecutive reasoning parts with non-empty text counts `1`
  (one run = one Thinking row, exactly as `mergeBurstSteps` merges it);
- anything else that survives into a row counts `1`.

A group row holding 5 reads therefore contributes 5, not 1. That is deliberate:
the reader's mental model of "steps" is calls-made, and the failure denominator
(`burstFailureCount`, which counts individual tool parts) must share the same
unit or `10 of 11` becomes arithmetic nonsense.

**Wording.**

| State | Label |
|---|---|
| running, `total === 0` | `Working` |
| running, `total > 0` | `Working · 4 steps` (`1 step` singular) |
| settled, `total === 0`, some plumbing present | `Housekeeping` |
| settled, `total === 0`, nothing at all | `Worked` |
| settled, `failed === 0` | `Completed 3 steps` (`Completed 1 step`) |
| settled, `failed > 0`, `completed > 0` | `Completed 10 of 11 steps · 1 failed` |
| settled, `failed > 0`, `completed === 0` | `2 steps failed` (`1 step failed`) |

Rules behind the table:

- **One noun, one verb per state.** "step(s)" always; "Completed" only when
  something completed. A burst where everything failed never says "Completed 0".
- **The failure clause is stated, not implied.** `10 of 11` alone requires the
  reader to subtract. `· 1 failed` costs eight characters and removes the
  subtraction. It is factual, lower-case, and carries no adjective — it does not
  say "error", "problem", or "issue".
- **No colour in the words.** The existing `WarningIcon` (destructive, `weight="fill"`,
  `aria-label`) stays as the shape signal for readers who cannot see the tint.
  It renders only while collapsed, unchanged.

`burstTitle` and `burst-title.test.ts` are deleted; `merge-steps.test.ts` drops its
one `burstTitle` assertion. Nothing else imports them.

The running label shimmers (`TextShimmer`), matching how every other row in this
chain says "still going". The settled label does not.

### 2.2 Read and write render as file chips

New module `turn/activity-file-chips.tsx`.

**When it applies.** A burst row is drawn as a file-chip row when every tool part
in it is the same file-reading or file-writing tool:

- `read` → verb `Read` / `Reading`, icon `FileTextIcon`
- `write` → verb `Wrote` / `Writing`, icon `PencilSimpleIcon`

`edit` / `apply_patch` are explicitly **out of scope** — their current renderer
shows a diff, which is the right output for a change. This is a rule about
*whole files the agent opened or produced*, not about edits.

**This includes a run of one.** `mergeBurstSteps` unwraps a group of one into a
flat `part` row today, which is right for a bash call but wrong here: the point
of the change is that a read is a *file*, and one file is still a file. A single
read renders `Read 1 file` opening to one chip. The unwrap rule in
`mergeBurstSteps` is left untouched — the decision is made at render time in
`ActivityBurst`, so the merge module stays pure and its tests stay green.

**The row.**

- Trigger: family icon + label (`Read 3 files`, running `Reading 3 files`,
  `Wrote 1 file`) at `font-medium`, plus the failure `WarningIcon` when the run
  holds a failure, plus the caret. Identical grammar and weight to
  `ActivityGroupStep`, because it *is* a group row — only its body differs.
- Body: the chips, wrapped, at `pl-7` (under the label, clear of the rail).
- Failed parts do not become chips. A file that could not be read has nothing to
  preview. They render below the chips as ordinary `ActivityStep` rows so the
  error card is still reachable.

**The chip.** Modelled on the user-message attachment tile, in the horizontal
form shown in the reference image:

```
┌─────────────────────────────┐
│ ┌────┐  package.json        │
│ │ {} │  JSON                │
│ └────┘                      │
└─────────────────────────────┘
```

- container: `border-border bg-background rounded-md border`, `px-3 py-2`,
  `flex items-center gap-3`, `max-w-full`, cursor-pointer
- icon tile: `size-9 rounded-md border border-border bg-muted/30`, centred,
  holding `getFileIcon(getFileType(filename))` at `size-4 text-muted-foreground`
- primary line: filename, `text-sm font-medium text-foreground`, truncated
- secondary line: `getTypeLabel(getFileType(filename), ext)`, `text-xs text-muted-foreground`
- hover `bg-muted/50`, press `active:scale-[0.98]`, `transition-colors`
  — the same three-part feel `ATTACHMENT_INTERACTIVE` gives every attachment
- one chip per **distinct path**; a file read twice in one run is one chip

**The click.** `useFilePreviewStore().openPreview(path)`. Inside a session that
routes to `openFileInSessionPanel` — the right-hand detail layer, which is
exactly what the user gets from a file mention or an attachment tile today.
`openFileInComputer` is not used: it is a one-line delegate to the same call.

The chip is a `<button type="button">` with an accessible name of
`Open ${filename}`. A chip whose path is unknown (no `filePath` in the tool
input) is not rendered as a chip — that part falls back to an `ActivityStep` row.

### 2.3 Breathing room

`ActivityGroupStep`'s member list moves from `mt-2 space-y-2` to
`mt-3 space-y-3`. The file-chip body uses `gap-2` between chips and the same
`mt-3` lead-in, so a group and a chip row open to the same rhythm.

## 3. Edge cases and what we do about them

| Case | Behaviour |
|---|---|
| Burst is all plumbing | `total === 0`, body renders nothing, title `Housekeeping`. Unchanged from today. |
| Burst is one long thought, no tools | `Completed 1 step`. A thought IS a row, so it counts. |
| Every tool in the burst failed | `3 steps failed`. No "Completed". |
| A failure inside a chip row | Warning glyph on the row; the failed part renders as a normal step under the chips. |
| Same file read 3× in one run | One chip. |
| Read with no resolvable path (streaming input not yet arrived) | Falls back to `ActivityStep`; no empty chip. |
| Running burst | No closing step, no failure count (`failures` is forced to 0 while running today — kept). |
| 37 steps | `Completed 37 steps`. No cap, no truncation — the number is the information. |

## 4. Verification

Per `no-browser-verification`: code-level proof only.

1. `bun test apps/web/src/features/session/turn/` — new `burst-summary.test.ts`
   covers every row of the wording table plus the counting rule; updated
   `activity-burst.test.tsx` renders a read run to static markup and asserts
   the chip filename, the type label, and the `Read 3 files` trigger.
2. `npx tsc --noEmit` in `apps/web` — clean apart from the 15 documented
   `@types/bun` `test.each` errors.
3. `npx eslint` on every touched file — zero errors.

## 5. Out of scope

- The `edit` / `apply_patch` renderers.
- The Easy/Advanced action panel (`ToolActivateContext` is already nulled inside
  a burst; nothing here reaches the panel).
- `narration.ts` families and the Easy-mode sentences.
- Any change to `mergeBurstSteps`' grouping or unwrapping rules.
