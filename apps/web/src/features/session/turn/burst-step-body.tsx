import { isToolPart, type Part } from '@/ui';
import { toolCallBlock } from '@kortix/sdk';
import { normalizeActivityToolName } from '../session-activity-groups';
import { ActivityFileChipStep, isFileChipCall } from './activity-file-chips';
import { ActivityGroupStep } from './activity-group-step';
import { ActivityStep, StepLabelRow } from './activity-step';
import { AnsweredQuestionStep, isAnsweredQuestionCall } from './answered-question-step';
import type { BurstStep } from './merge-steps';
import { stepLabel } from './step-label';

/**
 * True when this run is entirely one file family, so it can render as chips.
 *
 * `isFileChipCall` alone is not enough at a group row. `groupSteps` buckets by
 * NARRATION family, and `explore` holds `glob`/`grep`/`list` beside `read`
 * while `edit` holds `edit`/`apply_patch` beside `write` — so a run of two
 * reads and a grep arrives here as one group. Requiring the same normalized
 * tool name throughout keeps a grep out of a row whose only vocabulary is
 * files, and keeps `edit`/`apply_patch` on their diff renderer.
 */
function isFileChipRun(parts: ReadonlyArray<Part>): boolean {
  const first = parts[0];
  if (!first || !isToolPart(first) || !isFileChipCall(toolCallBlock(first))) return false;
  const name = normalizeActivityToolName(first.tool);
  return parts.every(
    (part) =>
      isToolPart(part) && isFileChipCall(toolCallBlock(part)) && normalizeActivityToolName(part.tool) === name,
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
 *
 * This is where the burst's v1 parts become session-log tool call blocks
 * (`toolCallBlock`, cached per part, so the rows' memos hold): every row below
 * reads blocks. The burst itself moves to blocks with the transcript (P5.2c).
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
    const calls = step.step.parts.map(toolCallBlock);
    return isFileChipRun(step.step.parts) ? (
      <ActivityFileChipStep calls={calls} sessionId={sessionId} disableNavigation={disableNavigation} />
    ) : (
      <ActivityGroupStep
        step={{ ...step.step, parts: calls }}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
      />
    );
  }
  // Neither tool nor reasoning: the label row only. The turn modules never
  // silently drop a part (`stepLabel` falls back to a generic 'Used' label).
  if (!isToolPart(step.part)) {
    return <StepLabelRow label={stepLabel(step.part)} running={running} bare={bareRow} />;
  }
  const call = toolCallBlock(step.part);
  // An answered question renders as its own chain row — "Questions · N
  // answered", opening in place — never as the generic tool card.
  if (isAnsweredQuestionCall(call)) {
    return <AnsweredQuestionStep call={call} bare={bareRow} />;
  }
  // A run of one read is unwrapped into a flat row by `mergeBurstSteps`, which
  // is right for a shell command and wrong here: one file is still a file.
  if (isFileChipCall(call)) {
    return (
      <ActivityFileChipStep
        calls={[call]}
        bare={bareRow}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
      />
    );
  }
  return (
    <ActivityStep call={call} bare={bareRow} sessionId={sessionId} disableNavigation={disableNavigation} />
  );
}
