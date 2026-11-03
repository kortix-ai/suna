'use client';

import type { SessionDisplayStatus } from '../actions/session-label';
import { SessionStatusMark } from '../../workspace/sidebar/session-status-mark';
import { useTranslations } from '../../i18n';
import type { WorkflowAgentStatus, WorkflowPhaseStatus } from '../tool/tools/workflow-run';
import type { AgentRowState } from './agent-model';

/**
 * Every agent surface draws the session list's glyphs (`SessionStatusMark`), so
 * an agent row and its session row read the same: green arc working, green
 * ring done, blue question needs you, red ring failed, gray ring stopped or not
 * started. The working arc stays still, as in the session list.
 */
const ROW_GLYPH: Record<AgentRowState, SessionDisplayStatus> = {
  working: 'running',
  needs_input: 'needs-you',
  failed: 'failed',
  idle: 'done',
  completed: 'done',
  stopped: 'stopped',
};

const RUN_GLYPH: Record<WorkflowPhaseStatus | WorkflowAgentStatus, SessionDisplayStatus> = {
  starting: 'starting',
  pending: 'starting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** The session-list glyph a workflow run, phase or agent status draws. */
export function runGlyphStatus(status: WorkflowPhaseStatus | WorkflowAgentStatus): SessionDisplayStatus {
  return RUN_GLYPH[status];
}

/** The glyph at 14px in a 14px slot: agent rows set 12px text, the session list 14px. */
function GlyphSlot({ status }: { status: SessionDisplayStatus }) {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
      <SessionStatusMark status={status} waitingOn="answer" />
    </span>
  );
}

/** The state mark of an agent row (the agents line, the agent pane, the multi-agent tool cards). */
export function AgentStateMark({ state }: { state: AgentRowState }) {
  const t = useTranslations('multiAgent.strip');
  return (
    <>
      <GlyphSlot status={ROW_GLYPH[state]} />
      <span className="sr-only">{t(`state.${state}`)}</span>
    </>
  );
}

/** The state mark of a workflow run, phase or agent. The word beside it is for a screen reader. */
export function RunStateMark({ status, label }: { status: WorkflowPhaseStatus | WorkflowAgentStatus; label: string }) {
  return (
    <>
      <GlyphSlot status={RUN_GLYPH[status]} />
      <span className="sr-only">{label}</span>
    </>
  );
}
