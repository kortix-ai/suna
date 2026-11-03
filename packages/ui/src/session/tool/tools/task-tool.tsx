'use client';

import { SubagentDialog } from '../../agents/subagent-view';
import {
  firstMeaningfulLine,
  partInput,
  partMetadata,
  partStatus,
  partError,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { SubAgentStatusBanner, useSubAgentThread } from '../shared/sub-agent';
import type { ToolProps } from '../shared/types';
import { ToolError } from '../tool-error';
import { useTranslations } from '../../../i18n';
import { getChildSessionId } from '../../../internal/session-types';
import { useMemo, useState } from 'react';
import type { SessionLogThread } from '@kortix/sdk';
import { useProjectSession, useSessionStateStore } from '@kortix/sdk/react';
import type { ProjectSession } from '@kortix/sdk';
import { agentDisplayName } from '../../../internal/components/agent-mark';
import { cn } from '../../../lib/utils';
import { useSessionIds } from '../../../providers/session-ids';
import type { SessionDisplayStatus } from '../../actions/session-label';
import { agentRowOf, type AgentRowState } from '../../agents/agent-model';
import { AgentCard, AgentGlyph } from '../../agents/agent-surface';

/**
 * Whether a background hand-off's child still works. The child's status is
 * known while this tab streams it; without it, a child whose last reply has
 * completed is not working, and any other child is taken as still at work.
 */
function useBackgroundWorking(childSessionId: string | undefined, childThread: SessionLogThread | null): boolean {
  const childStatus = useSessionStateStore((s) => (childSessionId ? s.sessionStatus[childSessionId] : undefined));
  if (childStatus?.type === 'busy' || childStatus?.type === 'retry') return true;
  if (childStatus?.type === 'idle') return false;
  const last = childThread?.messages.findLast((m) => m.role === 'assistant');
  return !last || last.completed_at === null;
}


/**
 * A task call is a disclosure row: what the sub-agent is doing, in place.
 *
 * This row used to be a plain button that opened `SubagentDialog` on any
 * click. That put the only view of a running sub-agent behind a modal — the
 * reader had to leave the transcript to learn what the agent they just
 * dispatched was up to, and had to close it again to get back — while the
 * `SubAgentActivity` list this component already assembled was unreachable dead
 * code on that path. The steps are the answer to the question the row raises,
 * so they belong under the row, and the modal is now an explicit action on the
 * row rather than the row's whole behaviour.
 *
 * The trigger is unchanged: while the sub-agent runs its subtitle is that
 * agent's LAST step, so a collapsed row still reports live progress.
 *
 * The body is the sub-agent's steps and NOTHING else, so it is passed only when
 * there are steps. A disclosure whose body is empty is a caret that promises a
 * body and opens onto nothing — the same verdict `ActivityBurst` reaches for a
 * burst that merges to zero rows. Before the full view moved to the trigger,
 * that button was the sole occupant of the body of a just-started sub-agent,
 * which is what kept the empty case from being empty.
 */
export function TaskTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tAgent = useTranslations('tools.agent');
  const input = partInput(call);
  const status = partStatus(call);

  const subagentType = (input.subagent_type as string) || 'general';
  // `firstMeaningfulLine` splits its argument on every newline and trims each
  // segment. A sub-agent prompt is the longest string this row ever sees, and
  // this ran over it on every render of a row that is mostly collapsed.
  const description = useMemo(
    () =>
      (input.description as string) ||
      firstMeaningfulLine(input.prompt) ||
      // Codex `spawn_agent`.
      firstMeaningfulLine(input.message) ||
      firstMeaningfulLine(input.title, 80),
    [input],
  );

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(call), [call]);

  const childThread = useSubAgentThread(childSessionId);

  // `agent(…, { background: true })` returns as soon as the child exists. The call is
  // over; the work goes on in the child's own session, and the row says so.
  const background = partMetadata(call).background === true;
  const backgroundWorking = useBackgroundWorking(background ? childSessionId : undefined, childThread);

  const [modalOpen, setModalOpen] = useState(false);
  const openModal = () => setModalOpen(true);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  // The task tool's failure reason, drawn in the body. The renderer routes
  // errored dispatches back here (they keep their row and their child thread),
  // and this row must still say WHY it failed — before it only announced the
  // dispatch, never the error (KRTX-1746).
  const errorText = partError(call);

  // The child's own session row says how it is doing; the call's status is the fallback.
  const ids = useSessionIds();
  const childRow = useProjectSession(ids.projectId, childSessionId, { enabled: !!ids.projectId && !!childSessionId });
  const childState: AgentRowState | null = childRow.data ? agentRowOf(childRow.data as ProjectSession).state : null;
  const state: AgentRowState = errorText
    ? 'failed'
    : (childState ?? (isRunning || (background && backgroundWorking) ? 'working' : isCompleted ? 'completed' : 'idle'));
  const agentName = agentDisplayName(subagentType);
  const title = description || tI18nComplete('text9471197a871a', { value0: agentName });

  // One card, one way in (Paper F2): the agent's live state, what it was asked, and Open. Its
  // steps and its transcript are in the agent pane, a click away; they never fold under the row.
  return (
    <>
      <AgentCard
        testId="agent-call-card"
        label={tAgent('openAgent', { name: title })}
        onClick={childSessionId ? openModal : undefined}
        className="mt-1.5"
      >
        <AgentGlyph status={STATE_GLYPH[state]} />
        <span className="text-foreground min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">{agentName}</span>
        <span className="flex-1" />
        <span className={cn('shrink-0 text-xs', state === 'failed' ? 'text-kortix-red' : state === 'needs_input' ? 'text-kortix-blue' : 'text-muted-foreground')}>
          {tAgent(`state.${state}`)}
        </span>
        {childSessionId && <span className="text-foreground shrink-0 text-xs">{tAgent('open')}</span>}
      </AgentCard>
      {errorText ? <ToolError error={errorText} toolName={call.name} /> : null}
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
      {childSessionId && (
        <SubagentDialog open={modalOpen} onOpenChange={setModalOpen} sessionId={childSessionId} title={title} />
      )}
    </>
  );
}

/** The session-list glyph an agent's state draws. */
const STATE_GLYPH: Record<AgentRowState, SessionDisplayStatus> = {
  working: 'running',
  needs_input: 'needs-you',
  failed: 'failed',
  idle: 'done',
  completed: 'done',
  stopped: 'stopped',
};
// pi's `agent` (`task` is its deprecated alias) reaches this row through its kind (`toolKind`).
ToolRegistry.register('task', TaskTool);
