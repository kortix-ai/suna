'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Hint } from '../../../primitives/hint';
import { ToolResultCard } from '../shared/result-card';
import { SubagentDialog } from '../../agents/subagent-view';
import { useTranslations } from '../../../i18n';
import {
  ArrowSquareOutIcon,
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
  type AgentBoardState,
  type PeerSendStatus,
  type PeerSendSummary,
  type ReachableAgentRow,
  type TeamTaskRow,
  type TeamTaskStatus,
} from './multi-agent-tool-data';

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

const PEER_VARIANT: Record<PeerSendStatus, BadgeVariant> = {
  delivered: 'success',
  held: 'warning',
  refused: 'warning',
  denied: 'warning',
  expired: 'muted',
  dropped: 'muted',
};

const STATE_VARIANT: Record<AgentBoardState, BadgeVariant> = {
  working: 'success',
  needs_input: 'warning',
  idle: 'muted',
  completed: 'success',
  failed: 'destructive',
  stopped: 'muted',
};

const TASK_VARIANT: Record<TeamTaskStatus, BadgeVariant> = {
  pending: 'muted',
  in_progress: 'info',
  completed: 'success',
};

const STATE_KEY: Record<AgentBoardState, string> = {
  working: 'working',
  needs_input: 'needsInput',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

const TASK_KEY: Record<TeamTaskStatus, string> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
};

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs';

function PeerSendBody({ send }: { send: PeerSendSummary }) {
  const t = useTranslations('multiAgent.tools');
  const preview = send.summary ?? send.message;
  return (
    <ToolResultCard bodyClassName="space-y-1 px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5" data-testid="peer-send-body">
        {send.to && (
          <>
            <span className="text-muted-foreground shrink-0">{t('to')}</span>
            <span className="text-foreground min-w-0 truncate font-medium">@{send.to}</span>
          </>
        )}
        <span className="flex-1" />
        <Badge variant={PEER_VARIANT[send.status]} size="sm" className="shrink-0">
          {t(`peerStatus.${send.status}`)}
        </Badge>
      </div>
      {preview && <p className="text-muted-foreground line-clamp-3 whitespace-pre-wrap wrap-break-word">{preview}</p>}
      {send.note && send.status !== 'delivered' && <p className="text-muted-foreground">{send.note}</p>}
    </ToolResultCard>
  );
}

function AgentLine({ agent }: { agent: ReachableAgentRow }) {
  const t = useTranslations('multiAgent.tools');
  const detail = agent.title ?? agent.agentName;
  const relation = t.has(`relation.${agent.relation}`) ? t(`relation.${agent.relation}`) : null;
  return (
    <div className={ROW_CLASS}>
      <span className="text-foreground shrink-0 font-medium">@{agent.handle}</span>
      {relation && <span className="text-muted-foreground shrink-0">{relation}</span>}
      {detail ? (
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={detail}>
          {detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {!agent.canReceive && (
        <Badge variant="muted" size="sm" className="shrink-0">
          {t('cannotReceive')}
        </Badge>
      )}
      {agent.state && (
        <Badge variant={STATE_VARIANT[agent.state]} size="sm" className="shrink-0">
          {t(`state.${STATE_KEY[agent.state]}`)}
        </Badge>
      )}
    </div>
  );
}

function TaskLine({ task }: { task: TeamTaskRow }) {
  const t = useTranslations('multiAgent.tools');
  return (
    <div className={ROW_CLASS} data-task-seq={task.seq}>
      <span className="text-muted-foreground shrink-0 tabular-nums">#{task.seq}</span>
      <span className="text-foreground min-w-0 flex-1 truncate" title={task.subject}>
        {task.subject}
      </span>
      {task.blockedBy.length > 0 && task.blocked && (
        <span className="text-muted-foreground shrink-0">
          {t('blockedBy', { tasks: task.blockedBy.map((n) => `#${n}`).join(', ') })}
        </span>
      )}
      {task.owner && (
        <Badge variant="outline" size="sm" className="shrink-0">
          @{task.owner}
        </Badge>
      )}
      <Badge variant={TASK_VARIANT[task.status]} size="sm" className="shrink-0">
        {t(`taskStatus.${TASK_KEY[task.status]}`)}
      </Badge>
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
      return send ? <PeerSendBody send={send} /> : null;
    }
    case 'list_agents': {
      const agents = parseReachable(result.data);
      if (!agents || agents.length === 0) return null;
      return (
        <RowList>
          {agents.map((agent) => (
            <li key={agent.sessionId}>
              <AgentLine agent={agent} />
            </li>
          ))}
        </RowList>
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
