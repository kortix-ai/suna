/**
 * `task` / `agent` — a sub-agent call as one card. Port of apps/web
 * `tool/tools/task-tool.tsx`:
 *
 *   ◠  Read the market report   Researcher        Working   Open
 *
 * status mark (the child session's state; fallback: the call's) · what it was
 * asked · the agent · its state · Open. The whole card opens the child
 * session; its steps and transcript are there, never folded under the row.
 * A failed dispatch shows why under the card.
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { getChildSessionId } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { useProjectSession } from '@/lib/projects/hooks';
import { agentDisplayName } from '@/lib/session/composer-config';
import { useSessionStatus } from '@/lib/session/session-store';
import { AGENT_CALL_GLYPH, AGENT_CALL_LABEL, agentCallState, agentSessionDisplay, taskRowModel } from '@/lib/session/tools/agents-task';
import { webSpace } from '@/lib/session/user-message';
import { ToolError } from '../tool-error';
import { AgentCard } from '../shared/agent-surface';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { partError, partInput, partMetadata, partStatus, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '../shared/styles';
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
  const title = model.description || `Agent · ${agentName}`;
  // Inside a sub-agent list navigation is off (web `disableNavigation`): nothing to open.
  const canOpen = navigationEnabled && !!childSessionId;

  return (
    <>
      <AgentCard
        testID="agent-call-card"
        label={`Open ${title}, ${AGENT_CALL_LABEL[state]}`}
        onPress={canOpen ? () => openSession(childSessionId!) : undefined}
        style={[{ marginTop: webSpace(1.5) }, !canOpen && { flexDirection: 'row', alignItems: 'center', gap: webSpace(2.5), paddingHorizontal: webSpace(3.5), minHeight: 44 }]}
      >
        <SessionStatusMark status={AGENT_CALL_GLYPH[state]} />
        <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.mutedForeground }]}>
          {agentName}
        </Text>
        <View style={{ flex: 1 }} />
        <Text
          style={[
            TURN_TYPE.xs,
            { color: state === 'failed' ? palette.destructive : state === 'needs_input' ? palette.info : palette.mutedForeground },
          ]}
        >
          {AGENT_CALL_LABEL[state]}
        </Text>
        {canOpen ? <Text style={[TURN_TYPE.xs, { color: palette.foreground }]}>Open</Text> : null}
      </AgentCard>
      {errorText ? <ToolError error={errorText} toolName={call.name} /> : null}
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
    </>
  );
}
ToolRegistry.register('task', TaskTool);
