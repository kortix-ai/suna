'use client';

import Loading from '../../../primitives/loading';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { SubSessionModal } from '../../thread/sub-session-modal';
import { GenericTool } from '../generic-tool';
import {
  BasicTool,
  partError,
  partMetadata,
  partOutput,
  partStatus,
  ToolOutcomeContext,
  ToolRunningContext,
  useToolIndent,
} from '../shared/infrastructure';
import { FoldedSection, OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import type { ToolProps } from '../shared/types';
import { ToolError } from '../tool-error';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { CheckIcon, FlowArrowIcon, MinusIcon, WarningIcon } from '@phosphor-icons/react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { useSessionChildren } from '@kortix/sdk/react';
import type { ProjectSession } from '@kortix/sdk';
import { useSessionIds } from '../../../providers/session-ids';
import {
  isWorkflowTool,
  parseWorkflowRun,
  type WorkflowAgentStatus,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowRunStatus,
} from './workflow-run';

/**
 * The card of pi's `workflow` tool: one script that runs several agents, each in
 * its own child session.
 *
 * The run arrives as part metadata (`WorkflowRunMetadata` in
 * `packages/api-contract/src/kortix-tool-card.ts`), pushed live with every change.
 * The card is the run's title and overall state, its phases, then one dense row
 * per agent: what it does, which agent it runs as, its state and the first line
 * of its answer. A row opens that agent's session in place, as a task row does
 * (`SubSessionModal`). Sixteen agents are sixteen lines, never sixteen cards.
 *
 * A call that settled with metadata that is not a run renders as the generic card.
 */

/**
 * One status mark for a run, a phase or an agent: a spinner while it works, else the
 * outcome. The glyph is decoration; the word beside it is for a screen reader.
 */
function StateMark({ status, label }: { status: WorkflowRunStatus | WorkflowAgentStatus; label: string }) {
  return (
    <>
      {status === 'starting' || status === 'running' ? (
        // `Loading` paints itself `text-background` inside a button; an agent row is one.
        <Loading className="text-muted-foreground in-[button]:text-muted-foreground size-3 shrink-0" />
      ) : status === 'done' ? (
        <CheckIcon aria-hidden className="text-kortix-green size-3 shrink-0" />
      ) : status === 'failed' ? (
        <WarningIcon weight="fill" aria-hidden className="text-kortix-red size-3 shrink-0" />
      ) : (
        <MinusIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
      )}
      <span className="sr-only">{label}</span>
    </>
  );
}

function WorkflowTrigger({ title, subtitle, live }: { title: string; subtitle?: string; live: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm">
      {live ? (
        <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-sm">
          {title}
        </TextShimmer>
      ) : (
        <span className="text-foreground min-w-0 truncate" title={title}>
          {title}
        </span>
      )}
      {subtitle && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={subtitle}>
          {subtitle}
        </span>
      )}
    </div>
  );
}

function PhaseLine({ run }: { run: WorkflowRun }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  return (
    <ol className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', indent && 'mt-1.5', indent)}>
      {run.phases.map((phase, index) => (
        <li key={`${phase.title}-${index}`} className="flex min-w-0 items-center gap-1.5">
          <StateMark status={phase.status} label={t(`status.${phase.status}`)} />
          <span className={cn('min-w-0 truncate', phase.status === 'running' ? 'text-foreground' : 'text-muted-foreground')}>
            {phase.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

const AGENT_ROW_CLASS = 'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs';

function AgentRow({ agent, onOpen }: { agent: WorkflowRunAgent; onOpen: (agent: WorkflowRunAgent) => void }) {
  const t = useTranslations('tools.workflow');
  const statusLabel = t(`status.${agent.status}`);
  const body = (
    <>
      <StateMark status={agent.status} label={statusLabel} />
      <span className="text-foreground min-w-0 shrink truncate" title={agent.label}>
        {agent.label}
      </span>
      {agent.agent && <span className="text-muted-foreground shrink-0">{agent.agent}</span>}
      <span className="text-muted-foreground min-w-0 flex-1 truncate" title={agent.summary}>
        {agent.summary ?? (agent.status === 'starting' || agent.status === 'running' ? '' : statusLabel)}
      </span>
    </>
  );
  if (!agent.sessionId) return <div className={AGENT_ROW_CLASS}>{body}</div>;
  return (
    <button
      type="button"
      aria-label={t('openAgent', { label: agent.label })}
      onClick={() => onOpen(agent)}
      className={cn(AGENT_ROW_CLASS, 'hover:bg-muted/40 cursor-pointer transition-colors')}
    >
      {body}
    </button>
  );
}

/**
 * A live run read from this session's children: each `agent()` is a child session named after
 * its label, started after the call. Null until the first child exists.
 */
export function runFromChildren(children: ProjectSession[], startedMs: number, input: unknown): WorkflowRun | null {
  const mine = children.filter((child) => !Number.isFinite(startedMs) || Date.parse(child.created_at) >= startedMs - 5_000);
  if (mine.length === 0) return null;
  const description = typeof (input as { description?: unknown } | null)?.description === 'string' ? (input as { description: string }).description : '';
  return {
    runId: '',
    title: description,
    status: 'running',
    phases: [],
    agents: mine
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((child, index) => ({
        id: `a${index + 1}`,
        label: (child.name ?? '').replace(/\s*\([^)]*\)\s*$/, '') || child.agent_name || child.session_id.slice(0, 8),
        ...(child.agent_name ? { agent: child.agent_name } : {}),
        status: child.status === 'completed' ? 'done' : child.status === 'failed' ? 'failed' : 'running',
        sessionId: child.session_id,
      })),
  };
}

export function WorkflowTool(props: ToolProps) {
  const { call, defaultOpen, forceOpen, locked } = props;
  const t = useTranslations('tools.workflow');
  const running = useContext(ToolRunningContext);
  const status = partStatus(call);
  const settled = status === 'completed' || status === 'error';
  const metadata = partMetadata(call);
  const parsed = useMemo(() => parseWorkflowRun(metadata), [metadata]);
  // The session log carries a running call's run document only once the call settles, so a
  // page that reads it (the v2 stream) has no live run. The run's agents are this session's
  // children started since the call began: list them until the document arrives.
  const ids = useSessionIds();
  const startedMs = call.started_at ? Date.parse(call.started_at) : NaN;
  const needChildren = !settled && !parsed && !!ids.projectId && !!ids.sessionId;
  const { sessions: children } = useSessionChildren(ids.projectId ?? '', ids.sessionId ?? '', { enabled: needChildren, limit: 20 });
  const run = useMemo(
    () => parsed ?? (needChildren ? runFromChildren(children, startedMs, call.input) : null),
    [parsed, needChildren, children, startedMs, call.input],
  );
  const [openAgent, setOpenAgent] = useState<WorkflowRunAgent | null>(null);
  const onOpen = useCallback((agent: WorkflowRunAgent) => setOpenAgent(agent), []);

  if (!isWorkflowTool(call.name) || (settled && !run)) {
    return <GenericTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={locked} />;
  }

  const icon = <FlowArrowIcon className="size-4 shrink-0" />;

  if (!run) {
    return (
      <BasicTool
        icon={icon}
        trigger={<WorkflowTrigger title={t('starting')} live={running} />}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      />
    );
  }

  const title = run.title || t('fallbackTitle');
  const total = run.agents.length;
  const done = run.agents.filter((agent) => agent.status === 'done').length;
  const failed = run.agents.filter((agent) => agent.status === 'failed').length;
  const progress = total > 0 ? t('progress', { done, total }) : undefined;
  const subtitle =
    run.status === 'running'
      ? // The call returned while the run goes on: it works in the background, not in this turn.
        settled
        ? [t('background'), progress].filter(Boolean).join(' · ')
        : progress
      : run.status === 'failed'
        ? (run.error?.split('\n')[0] ?? (total > 0 ? t('failedCount', { failed, total }) : undefined))
        : run.status === 'stopped'
          ? [t('status.stopped'), progress].filter(Boolean).join(' · ')
          : total === 0
            ? undefined
            : failed > 0
              ? t('failedCount', { failed, total })
              : t('agents', { count: total });
  const live = run.status === 'running' && !settled && running;
  const callError = status === 'error' ? partError(call) : undefined;
  const runError = run.error ?? callError;
  const output = status === 'completed' ? partOutput(call) : '';

  return (
    // A failed run leads with the shared failure triangle, as every failed call does. A
    // completed call whose run did not fail is not a failure, whatever its output says.
    <ToolOutcomeContext.Provider value={run.status === 'failed' || status === 'error' ? 'failed' : 'ok'}>
      <BasicTool
        icon={icon}
        trigger={<WorkflowTrigger title={title} subtitle={subtitle} live={live} />}
        defaultOpen={defaultOpen}
        // A running run is the thing to watch, and a failure must not hide behind a closed
        // row: either opens itself, so the rows say which agent is at work or broke.
        forceOpen={forceOpen || (run.agents.length > 0 && (run.status === 'running' || run.status === 'failed' || status === 'error'))}
        locked={locked}
      >
        <>
          {run.phases.length > 0 && <PhaseLine run={run} />}
          {run.agents.length > 0 && (
            <ToolResultCard bodyClassName="py-0.5">
              <ul>
                {run.agents.map((agent) => (
                  <li key={agent.id}>
                    <AgentRow agent={agent} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </ToolResultCard>
          )}
          {runError && run.status !== 'running' && <ToolError error={runError} toolName={call.name} />}
          {output && <WorkflowDetails output={output} />}
        </>
      </BasicTool>
      {openAgent?.sessionId && (
        <SubSessionModal
          open
          onOpenChange={(next) => {
            if (!next) setOpenAgent(null);
          }}
          sessionId={openAgent.sessionId}
          title={openAgent.agent ? `${openAgent.label} · ${openAgent.agent}` : openAgent.label}
        />
      )}
    </ToolOutcomeContext.Provider>
  );
}

function WorkflowDetails({ output }: { output: string }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  return (
    <div className={cn(indent && 'mt-1.5', indent)}>
      <FoldedSection label={t('showDetails')}>
        <OutputBlock text={output.length > 8_000 ? `${output.slice(0, 8_000)}\n…` : output} />
      </FoldedSection>
    </div>
  );
}

ToolRegistry.register('workflow', WorkflowTool);
