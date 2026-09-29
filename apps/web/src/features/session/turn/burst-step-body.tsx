import { isToolPart, type Part } from '@/ui';
import { normalizeActivityToolName } from '../session-activity-groups';
import { ActivityFileChipStep, isFileChipPart } from './activity-file-chips';
import { ActivityGroupStep } from './activity-group-step';
import { ActivityStep } from './activity-step';
import { AnsweredQuestionStep, isAnsweredQuestionPart } from './answered-question-step';
import type { BurstStep } from './merge-steps';

/**
 * True when this run is entirely one file family, so it can render as chips.
 *
 * `isFileChipPart` alone is not enough at a group row. `groupSteps` buckets by
 * NARRATION family, and `explore` holds `glob`/`grep`/`list` beside `read`
 * while `edit` holds `edit`/`apply_patch` beside `write` — so a run of two
 * reads and a grep arrives here as one group. Requiring the same normalized
 * tool name throughout keeps a grep out of a row whose only vocabulary is
 * files, and keeps `edit`/`apply_patch` on their diff renderer.
 */
function isFileChipRun(parts: ReadonlyArray<Part>): boolean {
  const first = parts[0];
  if (!first || !isToolPart(first) || !isFileChipPart(first)) return false;
  const name = normalizeActivityToolName(first.tool);
  return parts.every(
    (part) =>
      isToolPart(part) && isFileChipPart(part) && normalizeActivityToolName(part.tool) === name,
  );
}

/**
 * One step's body, without the chain wrapper.
 * Shared by the chain and by the bare single-step burst, so the two can never
 * draw the same row two different ways.
 *
 * `bare` is not styling — it says the row is the ONLY thing here, which is
 * what makes the leading glyph pointless (see `ActivityStep`) and what lets a
 * file-chip run with no chips fall back to the plain tool row instead of
 * drawing a "Read 1 file" door in front of it.
 */
export function StepBody({
  step,
  bareRow = false,
  running,
  sessionId,
  disableNavigation,
}: {
  step: Exclude<BurstStep, { kind: 'thought' }>;
  bareRow?: boolean;
  running: boolean;
  sessionId: string;
  disableNavigation?: boolean;
}) {
  if (step.kind === 'group') {
    // Files, not tool cards, when the whole run is reads or writes. The choice
    // is made here rather than in `mergeBurstSteps` so the merge module stays
    // pure and its unwrap-a-run-of-one rule is untouched — which is also why
    // the single-part branch below can reach the same row.
    return isFileChipRun(step.step.parts) ? (
      <ActivityFileChipStep
        parts={step.step.parts}
        running={running}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
      />
    ) : (
      <ActivityGroupStep
        step={step.step}
        sessionId={sessionId}
        running={running}
        disableNavigation={disableNavigation}
      />
    );
  }
  // An answered question renders as its own chain row — "Questions · N
  // answered", opening in place — never as the generic tool card.
  if (isAnsweredQuestionPart(step.part)) {
    return <AnsweredQuestionStep part={step.part} bare={bareRow} />;
  }
  // A run of one read is unwrapped into a flat row by `mergeBurstSteps`, which
  // is right for a shell command and wrong here: one file is still a file.
  if (isFileChipPart(step.part)) {
    return (
      <ActivityFileChipStep
        parts={[step.part]}
        bare={bareRow}
        running={running}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
      />
    );
  }
  return (
    <ActivityStep
      part={step.part}
      bare={bareRow}
      sessionId={sessionId}
      running={running}
      disableNavigation={disableNavigation}
    />
  );
}
