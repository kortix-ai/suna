import type { SessionLogBurstStep, ToolCallBlock } from '@kortix/sdk';
import { normalizeActivityToolName } from '@kortix/sdk';
import { ActivityFileChipStep, isFileChipCall } from './activity-file-chips';
import { ActivityGroupStep } from './activity-group-step';
import { ActivityStep, StepLabelRow } from './activity-step';
import { AnsweredQuestionStep, isAnsweredQuestionCall } from './answered-question-step';
import { stepLabel } from '@kortix/sdk';
import { ToolRegistry } from '../tool/shared/registry';

/** A host's `ToolRegistry.register` row for this tool wins over the chip and question rows. */
const hostRow = (call: ToolCallBlock) => ToolRegistry.replaced(call.name, call.kind);

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
function isFileChipRun(calls: ReadonlyArray<ToolCallBlock>): boolean {
  const first = calls[0];
  if (!first || !isFileChipCall(first) || calls.some(hostRow)) return false;
  const name = normalizeActivityToolName(first.name);
  return calls.every((call) => isFileChipCall(call) && normalizeActivityToolName(call.name) === name);
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
  step: Exclude<SessionLogBurstStep, { kind: 'thought' }>;
  bareRow?: boolean;
  running: boolean;
  sessionId: string;
  disableNavigation?: boolean;
}) {
  if (step.kind === 'group') {
    // Files, not tool cards, when the whole run is reads or writes. The choice
    // is made here rather than in the burst steps so the merge rules stay
    // pure and their unwrap-a-run-of-one rule is untouched — which is also why
    // the single-call branch below can reach the same row.
    const calls = step.blocks;
    return isFileChipRun(calls) ? (
      <ActivityFileChipStep calls={calls} sessionId={sessionId} disableNavigation={disableNavigation} />
    ) : (
      <ActivityGroupStep
        step={{ id: calls[0]!.call_id, family: step.family, label: step.label, parts: calls, status: step.status, durationMs: step.durationMs }}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
      />
    );
  }
  // Neither tool nor reasoning: the label row only. The turn modules never
  // silently drop a block (`stepLabel` falls back to a generic 'Used' label).
  if (step.block.type !== 'tool_call') {
    return <StepLabelRow label={stepLabel(step.block)} running={running} bare={bareRow} />;
  }
  const call = step.block;
  // An answered question renders as its own chain row — "Questions · N
  // answered", opening in place — never as the generic tool card.
  if (isAnsweredQuestionCall(call) && !hostRow(call)) {
    return <AnsweredQuestionStep call={call} bare={bareRow} />;
  }
  // A run of one read is unwrapped into a flat row by the burst steps, which
  // is right for a shell command and wrong here: one file is still a file.
  if (isFileChipCall(call) && !hostRow(call)) {
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
