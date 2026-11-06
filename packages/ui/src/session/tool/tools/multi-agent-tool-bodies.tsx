'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Hint } from '../../../primitives/hint';
import { ToolResultCard } from '../shared/result-card';
import { SubagentDialog } from '../../agents/subagent-view';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { AgentStateMark } from '../../agents/agent-state-mark';
import { subagentTitle } from '../../agents/agent-model';
import { agentDisplayName } from '../../../internal/components/agent-mark';
import { AgentFace, AgentHandle, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger, SmallGlyph, taskGlyphStatus } from '../../agents/agent-surface';
import type { SessionDisplayStatus } from '../../actions/session-label';
import { BasicTool } from '../shared/infrastructure';
import {
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  ListChecksIcon,
  PaperPlaneTiltIcon,
  StopCircleIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import type { KortixToolResult, MultiAgentTool } from './kortix-tool-card';
import {
  parsePeerSend,
  parseReachable,
  parseStoppedChild,
  parseTasks,
  type StoppedChild,
  type SessionBoardState,
  type PeerMessageStatus,
  type PeerSendSummary,
  type ReachableAgentRow,
  type TeamTaskRow,
  type SessionTaskStatus,
} from '@kortix/sdk';

/**
 * The card bodies of the multi-agent tools (`send_message`, `list_agents`,
 * `task_*`, `task_stop`), drawn from the result's `data`. Each status chip takes
 * the hue of its meaning (color.md status table): green done or running, orange
 * waiting on a person or refused by design, red failed, no hue idle.
 */

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'info' | 'muted';

export const MULTI_AGENT_ICON: Record<MultiAgentTool, Icon> = {
  send_message: PaperPlaneTiltIcon,
  list_agents: UsersThreeIcon,
  task_create: ListChecksIcon,
  task_list: ListChecksIcon,
  task_get: ListChecksIcon,
  task_update: ListChecksIcon,
  task_stop: StopCircleIcon,
};

/** The key under `multiAgent.tools.running` for a call still in flight. */
export function runningKey(tool: MultiAgentTool): 'sending' | 'checkingAgents' | 'checkingTasks' | 'updatingTasks' | 'stopping' {
  switch (tool) {
    case 'send_message':
      return 'sending';
    case 'list_agents':
      return 'checkingAgents';
    case 'task_list':
    case 'task_get':
      return 'checkingTasks';
    case 'task_create':
    case 'task_update':
      return 'updatingTasks';
    case 'task_stop':
      return 'stopping';
  }
}

const TASK_VARIANT: Record<SessionTaskStatus, BadgeVariant> = {
  pending: 'muted',
  in_progress: 'info',
  completed: 'success',
};

const STATE_KEY: Record<SessionBoardState, string> = {
  working: 'working',
  needs_input: 'needsInput',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

const TASK_KEY: Record<SessionTaskStatus, string> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
};

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs';

/** An agent's face as a tool row's 16px icon: its pixel mark on its own tile. */
export const AgentAvatarIcon = AgentFace;

/** The state a send ended in, as a session-list glyph: delivered is done, held waits on a person. */
const PEER_GLYPH: Record<PeerMessageStatus, SessionDisplayStatus> = {
  delivered: 'done',
  held: 'needs-you',
  refused: 'stopped',
  denied: 'stopped',
  expired: 'stopped',
  dropped: 'stopped',
};

/**
 * `send_message`: one agent row, the receiver's face as its icon:
 *
 *   [face] To reviewer  Migration finished                  ✓ Delivered
 *          │ the whole message
 *          │ why it did not arrive, when it did not
 *
 * The state is a glyph and a muted word: a held message waits on a person, it did not fail.
 */
export function PeerSendRow({ send, defaultOpen, forceOpen, locked }: { send: PeerSendSummary; defaultOpen?: boolean; forceOpen?: boolean; locked?: boolean }) {
  const t = useTranslations('multiAgent.tools');
  const delivered = send.status === 'delivered';
  const preview = send.summary || firstLineOf(send.message) || undefined;
  const hasBody = !!send.message || (!delivered && !!send.note);
  return (
    <AgentRowScope>
      <BasicTool
        icon={send.to ? <AgentFace handle={send.to} /> : undefined}
        trigger={<AgentTrigger title={send.to ? t('messageToName', { to: send.to }) : t('messageSent')} subtitle={preview} />}
        triggerAction={<AgentStatus status={PEER_GLYPH[send.status]} label={t(`peerStatus.${send.status}`)} opens={hasBody} />}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {hasBody ? (
          <AgentRowBody>
            {send.message && <p className="text-foreground whitespace-pre-wrap wrap-break-word">{send.message}</p>}
            {!delivered && send.note && <p className="text-muted-foreground">{send.note}</p>}
          </AgentRowBody>
        ) : undefined}
      </BasicTool>
    </AgentRowScope>
  );
}

function firstLineOf(text: string | null): string {
  return text?.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** Row actions: shown on hover and on keyboard focus, always on a touch screen (as in the agents line). */
const ROW_ACTIONS =
  'flex shrink-0 items-center pr-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * One agent `list_agents` found, drawn as the agents line draws it: the state
 * mark, the handle and its state, then one muted line with what it works on
 * and how it relates to this session. The row opens the agent's session.
 */
function AgentLine({ agent }: { agent: ReachableAgentRow }) {
  const t = useTranslations('multiAgent.tools');
  const tStrip = useTranslations('multiAgent.strip');
  const [viewing, setViewing] = useState(false);
  const title = agent.title ? subagentTitle(agent.title) || null : null;
  const relation = t.has(`relation.${agent.relation}`) ? t(`relation.${agent.relation}`) : null;
  const meta = [
    title ?? (agent.agentName ? tStrip('runsAs', { agent: agentDisplayName(agent.agentName) }) : null),
    relation,
    agent.canReceive ? null : t('cannotReceive'),
  ]
    .filter(Boolean)
    .join(' · ');
  const name = `@${agent.handle}`;
  return (
    <li className="group/row hover:bg-hover focus-within:bg-hover flex min-w-0 items-center gap-1 rounded-sm" data-agent-row={agent.sessionId}>
      <button
        type="button"
        onClick={() => setViewing(true)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2 text-left text-xs outline-none"
      >
        {agent.state ? <AgentStateMark state={agent.state} /> : <span aria-hidden className="size-3 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-foreground min-w-0 truncate font-medium">{name}</span>
            {agent.state && (
              <span className="text-muted-foreground shrink-0">{t(`state.${STATE_KEY[agent.state]}`)}</span>
            )}
          </span>
          {meta && (
            <span className="text-muted-foreground block truncate" title={meta}>
              {meta}
            </span>
          )}
        </span>
      </button>
      <div className={ROW_ACTIONS}>
        <Hint label={tStrip('openAgent', { name })} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tStrip('openAgent', { name })}
            onClick={() => setViewing(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={agent.sessionId} title={name} />
    </li>
  );
}

function TaskLine({ task }: { task: TeamTaskRow }) {
  const t = useTranslations('multiAgent.tools');
  const done = task.status === 'completed';
  return (
    <div className={ROW_CLASS} data-task-seq={task.seq}>
      <SmallGlyph status={task.blocked && !done ? 'stopped' : taskGlyphStatus(task.status)} label={t(`taskStatus.${TASK_KEY[task.status]}`)} />
      <span className="text-muted-foreground shrink-0 tabular-nums">#{task.seq}</span>
      <span className={cn('min-w-0 flex-1 truncate', done ? 'text-muted-foreground' : 'text-foreground')} title={task.subject}>
        {task.subject}
      </span>
      {task.blockedBy.length > 0 && task.blocked && (
        <span className="text-muted-foreground shrink-0">
          {t('blockedBy', { tasks: task.blockedBy.map((n) => `#${n}`).join(', ') })}
        </span>
      )}
      {task.owner && <AgentHandle handle={task.owner} />}
    </div>
  );
}

/** `task_stop`: the agent it stopped, whether it was still running, and a way into its session. */
function StoppedChildBody({ child }: { child: StoppedChild }) {
  const t = useTranslations('multiAgent.tools');
  const [viewing, setViewing] = useState(false);
  const name = child.handle ? `@${child.handle}` : (child.title ?? child.sessionId.slice(0, 8));
  const detail = child.handle ? child.title : null;
  return (
    <ToolResultCard bodyClassName="py-0.5">
      <div className={ROW_CLASS} data-testid="stopped-child-body">
        <span className="text-foreground shrink-0 font-medium">{name}</span>
        {detail ? (
          <>
            <span aria-hidden className="text-muted-foreground shrink-0">
              ·
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate" title={detail}>
              {detail}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <Badge variant="muted" size="sm" className="shrink-0">
          {child.stopped ? t('stopped') : t('alreadyEnded')}
        </Badge>
        <Hint label={t('openSession')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('openSession')}
            onClick={() => setViewing(true)}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={child.sessionId} title={name} />
    </ToolResultCard>
  );
}

function RowList({ children }: { children: ReactNode[] }) {
  return (
    <ToolResultCard bodyClassName="py-0.5">
      <ul>{children}</ul>
    </ToolResultCard>
  );
}

/**
 * The body a multi-agent result draws from its `data`, or `null` when the data
 * does not parse or holds nothing to show (the card's own rows draw instead).
 */
export function multiAgentBody(tool: MultiAgentTool, result: KortixToolResult): ReactNode | null {
  switch (tool) {
    case 'send_message': {
      const send = parsePeerSend(result.data);
      return send ? <PeerSendRow send={send} /> : null;
    }
    case 'list_agents': {
      const agents = parseReachable(result.data);
      if (!agents || agents.length === 0) return null;
      return (
        <ToolResultCard bodyClassName="p-1">
          <ul>
            {agents.map((agent) => (
              <AgentLine key={agent.sessionId} agent={agent} />
            ))}
          </ul>
        </ToolResultCard>
      );
    }
    case 'task_create':
    case 'task_list':
    case 'task_get':
    case 'task_update': {
      const tasks = parseTasks(result.data);
      if (!tasks || tasks.length === 0) return null;
      return (
        <RowList>
          {tasks.map((task) => (
            <li key={task.seq}>
              <TaskLine task={task} />
            </li>
          ))}
        </RowList>
      );
    }
    case 'task_stop': {
      const child = parseStoppedChild(result.data);
      return child ? <StoppedChildBody child={child} /> : null;
    }
  }
}
