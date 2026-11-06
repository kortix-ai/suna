'use client';

import { SubagentDialog } from '../../agents/subagent-view';
import { BasicTool, ToolSurfaceContext, firstMeaningfulLine, partInput, partMetadata, partStatus, partError } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { SubAgentStatusBanner, useSubAgentThread } from '../shared/sub-agent';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { getChildSessionId } from '../../../internal/session-types';
import { useContext, useMemo, useState } from 'react';
import type { ProjectSession, SessionLogThread } from '@kortix/sdk';
import { useProjectSession, useSessionStateStore } from '@kortix/sdk/react';
import { agentDisplayName } from '../../../internal/components/agent-mark';
import { useSessionIds } from '../../../providers/session-ids';
import type { SessionDisplayStatus } from '../../actions/session-label';
import { agentRowOf, type AgentRowState } from '../../agents/agent-model';
import { AgentFace, AgentFailure, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger, OpenAgentButton } from '../../agents/agent-surface';

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
 * An agent call (`agent`, `task`, Codex `spawn_agent`) is one tool row, the
 * grammar of every other tool row:
 *
 *   [face] Researcher  Research competitor pricing…          ◔ Working  >
 *
 * A click opens the agent's session in the side panel (its face, name, state,
 * conversation and a box to message it); without a panel, in the agent dialog.
 */
export function TaskTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const t = useTranslations('tools.agent');
  const tNotice = useTranslations('multiAgent.notice');
  const input = partInput(call);
  const status = partStatus(call);

  const subagentType = (input.subagent_type as string) || (input.agent as string) || 'general';
  const description = useMemo(
    () =>
      (input.description as string) ||
      firstMeaningfulLine(input.prompt) ||
      // Codex `spawn_agent`.
      firstMeaningfulLine(input.message) ||
      firstMeaningfulLine(input.title, 80),
    [input],
  );
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : typeof input.message === 'string' ? input.message.trim() : '';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(call), [call]);
  const childThread = useSubAgentThread(childSessionId);

  // `agent(…, { background: true })` returns as soon as the child exists. The call is
  // over; the work goes on in the child's own session, and the row says so.
  const background = partMetadata(call).background === true;
  const backgroundWorking = useBackgroundWorking(background ? childSessionId : undefined, childThread);

  const [modalOpen, setModalOpen] = useState(false);
  const isRunning = status === 'running' || status === 'pending';
  const errorText = partError(call);

  // The child's own session row says how it is doing; the call's status is the fallback.
  const ids = useSessionIds();
  const childRow = useProjectSession(ids.projectId, childSessionId, { enabled: !!ids.projectId && !!childSessionId });
  const child = childRow.data ? agentRowOf(childRow.data as ProjectSession) : null;
  const state: AgentRowState = errorText
    ? 'failed'
    : (child?.state ?? (isRunning || (background && backgroundWorking) ? 'working' : status === 'completed' ? 'completed' : 'idle'));
  // The name its parent gave it (`agent({ name })`) reads best; else the kind of agent.
  const handle = (input.name as string) || (child?.named ? child.handle : '') || subagentType;
  const title = (input.name as string) || (child?.named ? child.handle : '') || agentDisplayName(subagentType);

  // A row with a session opens it: beside the chat in the side panel, or as the agent
  // dialog where there is no panel. Its prompt, steps and answer are that session's
  // conversation, so the row carries no copy of them. A call that never got a
  // session keeps what it has in place. On the panel's own surface a row is a fold
  // (it takes no click), so there the fold holds Open.
  const surface = useContext(ToolSurfaceContext);
  const opensAgent = !!childSessionId && surface !== 'panel';
  const hasBody = !opensAgent && (!!prompt || !!errorText || !!childSessionId);
  return (
    <AgentRowScope>
      <BasicTool
        icon={<AgentFace handle={handle} />}
        trigger={<AgentTrigger title={title} subtitle={description} />}
        triggerAction={<AgentStatus status={STATE_GLYPH[state]} label={t(`state.${state}`)} opens={opensAgent || hasBody} />}
        onClick={opensAgent ? () => setModalOpen(true) : undefined}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {hasBody ? (
          <AgentRowBody>
            {prompt && prompt !== description && (
              <p className="text-muted-foreground line-clamp-4 whitespace-pre-wrap wrap-break-word">{prompt}</p>
            )}
            {errorText && <AgentFailure sentence={tNotice('failedSentence')} raw={errorText} />}
            {childSessionId && <OpenAgentButton label={t('openAgent', { name: description || title })} onClick={() => setModalOpen(true)} />}
          </AgentRowBody>
        ) : undefined}
      </BasicTool>
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
      {childSessionId && (
        <SubagentDialog open={modalOpen} onOpenChange={setModalOpen} sessionId={childSessionId} title={title} handle={handle} task={description || undefined} failure={errorText || undefined} />
      )}
    </AgentRowScope>
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
