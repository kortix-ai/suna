/**
 * `task` / `agent` — a sub-agent call as one agent row. Port of apps/web
 * `tool/tools/task-tool.tsx`:
 *
 *   [face] Researcher  Read the market report             ◠ Working
 *          │ the brief · why it did not finish · Open ↗
 *
 * The state is the child session's (fallback: the call's), as a glyph and a muted word.
 */

import { useContext, useMemo } from 'react';
import { getChildSessionId } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { useProjectSession } from '@/lib/projects/hooks';
import { agentDisplayName } from '@/lib/session/composer-config';
import { useSessionStatus } from '@/lib/session/session-store';
import { AGENT_CALL_GLYPH, AGENT_CALL_LABEL, agentCallState, agentSessionDisplay, taskRowModel } from '@/lib/session/tools/agents-task';
import { AgentFailure, AgentRow, AgentRowBody, OpenAgentAction } from '../shared/message-row';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { partError, partInput, partMetadata, partStatus, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { SubAgentStatusBanner, useChildSession } from './sub-agent';

export function TaskTool({ call }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(call);
  const status = partStatus(call);
  const errorText = partError(call);
  const childSessionId = useMemo(() => getChildSessionId(call), [call]);
  const { childThread, childCalls } = useChildSession(childSessionId);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();
  const handoff = useContext(ConnectorHandoffContext);
  const childRow = useProjectSession(handoff?.projectId ?? null, childSessionId ?? null).data;
  const childLive = useSessionStatus(childSessionId);

  const model = useMemo(
    () => taskRowModel({ status, input, childSessionId, childCalls }),
    [status, input, childSessionId, childCalls],
  );
  const lastReply = childThread?.messages.findLast((message) => message.role === 'assistant');
  const state = agentCallState({
    status,
    hasError: !!errorText,
    background: partMetadata(call).background === true,
    childDisplay: childRow ? agentSessionDisplay(childRow) : null,
    childLiveType: childLive?.type ?? null,
    childReplied: !!lastReply && lastReply.completed_at !== null,
  });
  const agentName = agentDisplayName(model.subagentType);
  const handle = typeof input.name === 'string' && input.name ? input.name : null;
  const title = handle ?? agentName;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const canOpen = navigationEnabled && !!childSessionId;
  const hasBody = (!!prompt && prompt !== model.description) || !!errorText || canOpen;

  // One agent row (web `TaskTool`): face · who · what it was asked · state. Open, the brief,
  // why it did not finish, and Open for the agent's own session.
  return (
    <>
      <AgentRow
        testID="agent-call-row"
        handle={handle ?? model.subagentType}
        title={title}
        subtitle={model.description || null}
        state={AGENT_CALL_LABEL[state]}
        glyph={AGENT_CALL_GLYPH[state]}
        body={
          hasBody ? (
            <AgentRowBody>
              {prompt && prompt !== model.description ? (
                <Text numberOfLines={4} style={[TURN_TYPE.sm, { color: palette.mutedForeground }]}>
                  {prompt}
                </Text>
              ) : null}
              {errorText ? <AgentFailure sentence="The agent stopped before it finished." raw={errorText} toolName={call.name} /> : null}
              {canOpen ? <OpenAgentAction label={`Open ${title}`} onPress={() => openSession(childSessionId!)} /> : null}
            </AgentRowBody>
          ) : undefined
        }
      />
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
    </>
  );
}
ToolRegistry.register('task', TaskTool);
