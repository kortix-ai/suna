/**
 * pi's multi-agent tools, as mobile draws them. Port of apps/web
 * `tool/tools/kortix-action-tool.tsx` (the multi-agent branch),
 * `multi-agent-tool-bodies.tsx` and `multi-agent-tools.tsx`:
 *
 *   send_message       a message card: the receiver's face · "Message to @x" · delivery · text
 *   list_agents        one row per agent: state mark · @handle · state · title; tap opens it
 *   task_*  (team)     one row per task: status mark · #seq · subject · blocked by · owner
 *   task_stop          the agent it stopped · Stopped · open
 *
 * `task_create`, `task_list`, `task_get` and `task_update` also name the older
 * plugin tools; `isTeamTaskCall` tells them apart (web's check), so a transcript
 * from before pi keeps its old row.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import {
  looksLikeTeamTaskInput,
  multiAgentTool,
  parseKortixToolResult,
  parsePeerSend,
  parseReachable,
  parseStoppedChild,
  parseTasks,
  type MultiAgentTool,
  type PeerSendSummary,
  type ReachableAgentRow,
  type StoppedChild,
  type TeamTaskRow,
} from '@kortix/sdk';
import { peerHandleLabel } from '@kortix/shared';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { ChatCircleIcon, ListChecksIcon, StopCircleIcon, UsersThreeIcon } from '@/lib/icons';
import { AGENT_STATE_LABEL, PEER_STATUS_LABEL, agentStateGlyph, taskGlyph } from '@/lib/session/multi-agent';
import { webSpace } from '@/lib/session/user-message';
import { AgentCard } from '../shared/agent-surface';
import { MessageRow } from '../shared/message-row';
import { AgentPixelMark, agentSlugOfHandle } from '../shared/agent-pixel-mark';
import { BasicTool, partError, partInput, partRawOutput, partStatus, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolComponent, ToolProps } from '../shared/types';
import { AgentSpawnTool } from './agent-spawn-tool';
import { AgentTaskUpdateTool } from './agent-task-update-tool';
import { TaskListTool } from './task-list-tool';

/** Web `multiAgent.tools.running`: the row while the call runs. */
const RUNNING: Record<MultiAgentTool, string> = {
  send_message: 'Sending a message…',
  list_agents: 'Checking the other agents…',
  task_create: 'Updating the team tasks…',
  task_update: 'Updating the team tasks…',
  task_list: 'Checking the team tasks…',
  task_get: 'Checking the team tasks…',
  task_stop: 'Stopping an agent…',
};

const ICON: Record<MultiAgentTool, typeof ChatCircleIcon> = {
  send_message: ChatCircleIcon,
  list_agents: UsersThreeIcon,
  task_create: ListChecksIcon,
  task_update: ListChecksIcon,
  task_list: ListChecksIcon,
  task_get: ListChecksIcon,
  task_stop: StopCircleIcon,
};

const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: webSpace(2.5), paddingHorizontal: webSpace(3.5), minHeight: 44 };

/** True when a call is pi's team-task tool, not the older plugin tool of the same name. */
export function isTeamTaskCall(call: ToolProps['call']): boolean {
  const status = partStatus(call);
  if (status === 'completed' || status === 'error') {
    const raw = status === 'error' ? (partError(call) ?? '') : partRawOutput(call);
    return parseKortixToolResult(raw, call.name) !== null;
  }
  return looksLikeTeamTaskInput(partInput(call));
}

export function MultiAgentToolCard({ call, forceOpen }: ToolProps) {
  const tool = multiAgentTool(call.name);
  const status = partStatus(call);
  const settled = status === 'completed' || status === 'error';
  const raw = status === 'error' ? (partError(call) ?? '') : partRawOutput(call);
  const result = settled ? parseKortixToolResult(raw, call.name) : null;
  if (!tool) return null;
  if (!result) {
    return <BasicTool icon={ICON[tool]} trigger={{ title: settled ? (partError(call) ?? RUNNING[tool]) : RUNNING[tool] }} forceOpen={forceOpen} />;
  }
  const body = multiAgentBody(tool, result.data);
  if (tool === 'send_message' && body) return body;
  return (
    <BasicTool icon={ICON[tool]} trigger={{ title: result.card.title, subtitle: result.card.subtitle }} defaultOpen forceOpen={forceOpen}>
      {body}
    </BasicTool>
  );
}

function multiAgentBody(tool: MultiAgentTool, data: unknown): ReactNode | null {
  switch (tool) {
    case 'send_message': {
      const send = parsePeerSend(data);
      return send ? <PeerSendRow send={send} /> : null;
    }
    case 'list_agents': {
      const agents = parseReachable(data);
      return agents && agents.length > 0 ? <RowsCard>{agents.map((agent) => <AgentRow key={agent.sessionId} agent={agent} />)}</RowsCard> : null;
    }
    case 'task_stop': {
      const child = parseStoppedChild(data);
      return child ? <StoppedChildCard child={child} /> : null;
    }
    default: {
      const tasks = parseTasks(data);
      return tasks && tasks.length > 0 ? <RowsCard>{tasks.map((task) => <TaskRow key={task.seq} task={task} />)}</RowsCard> : null;
    }
  }
}

function RowsCard({ children }: { children: ReactNode[] }) {
  return <AgentCard style={{ marginTop: webSpace(1.5) }}>{children}</AgentCard>;
}

/**
 * `send_message`: one plain row, the receiver's face as its icon. Not delivered, the
 * row says why (the API's note) and the state reads red; failures never get a card.
 */
export function PeerSendRow({ send }: { send: PeerSendSummary }) {
  const delivered = send.status === 'delivered';
  return (
    <MessageRow
      testID="peer-send-row"
      handle={send.to}
      title={send.to ? `To ${peerHandleLabel(send.to).replace(/^@/, '')}` : 'Message sent'}
      subtitle={send.summary || send.message}
      state={PEER_STATUS_LABEL[send.status]}
      glyph={delivered ? 'done' : send.status === 'held' ? 'needs-you' : 'stopped'}
      text={[send.message, !delivered ? send.note : null].filter(Boolean).join('\n\n')}
    />
  );
}

function AgentRow({ agent }: { agent: ReachableAgentRow }) {
  const palette = useTurnPalette();
  const { enabled, openSession } = useToolNavigation();
  const body = (
    <>
      {agent.state ? <SessionStatusMark status={agentStateGlyph(agent.state)} /> : <View style={{ width: 16 }} />}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: webSpace(2) }}>
          <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            @{agent.handle}
          </Text>
          {agent.state ? <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{AGENT_STATE_LABEL[agent.state]}</Text> : null}
        </View>
        {agent.title ? (
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
            {agent.title}
          </Text>
        ) : null}
      </View>
    </>
  );
  return enabled ? (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={`Open @${agent.handle}${agent.state ? `, ${AGENT_STATE_LABEL[agent.state]}` : ''}`}
      onPress={() => openSession(agent.sessionId)}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: palette.pressed }]}
    >
      {body}
    </PressableSurface>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

function TaskRow({ task }: { task: TeamTaskRow }) {
  const palette = useTurnPalette();
  const done = task.status === 'completed';
  return (
    <View style={rowStyle} accessibilityLabel={`#${task.seq} ${task.subject}`}>
      <SessionStatusMark status={taskGlyph(task)} />
      <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}>#{task.seq}</Text>
      <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, color: done ? palette.mutedForeground : palette.foreground }]}>
        {task.subject}
      </Text>
      {task.blocked && task.blockedBy.length > 0 ? (
        <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>Blocked by {task.blockedBy.map((n) => `#${n}`).join(', ')}</Text>
      ) : null}
      {task.owner ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1.5), maxWidth: '35%' }}>
          <AgentPixelMark slug={agentSlugOfHandle(task.owner)} tile={16} />
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.mutedForeground }]}>
            @{task.owner}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function StoppedChildCard({ child }: { child: StoppedChild }) {
  const palette = useTurnPalette();
  const { enabled, openSession } = useToolNavigation();
  const name = child.handle ? `@${child.handle}` : (child.title ?? 'Agent');
  return (
    <AgentCard
      testID="stopped-child-card"
      label={`Open ${name}`}
      onPress={enabled ? () => openSession(child.sessionId) : undefined}
      style={[{ marginTop: webSpace(1.5) }, !enabled && rowStyle]}
    >
      <SessionStatusMark status="stopped" />
      <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
        {name}
      </Text>
      {child.handle && child.title ? (
        <Text numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.mutedForeground }]}>
          {child.title}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{child.stopped ? 'Stopped' : 'Already ended'}</Text>
      {enabled ? <Text style={[TURN_TYPE.xs, { color: palette.foreground }]}>Open</Text> : null}
    </AgentCard>
  );
}

function teamTaskTool(legacy: ToolComponent): ToolComponent {
  function TeamTaskTool(props: ToolProps) {
    const Component = isTeamTaskCall(props.call) ? MultiAgentToolCard : legacy;
    return <Component {...props} />;
  }
  TeamTaskTool.displayName = `TeamTaskTool(${legacy.displayName ?? legacy.name})`;
  return TeamTaskTool;
}

// Imported last by `register-agents.ts`, so these win the keys the older tools registered.
ToolRegistry.register('send-message', MultiAgentToolCard);
ToolRegistry.register('list-agents', MultiAgentToolCard);
ToolRegistry.register('task-stop', MultiAgentToolCard);
ToolRegistry.register('task-create', teamTaskTool(AgentSpawnTool));
ToolRegistry.register('task-update', teamTaskTool(AgentTaskUpdateTool));
ToolRegistry.register('task-list', teamTaskTool(TaskListTool));
ToolRegistry.register('task-get', teamTaskTool(TaskListTool));
