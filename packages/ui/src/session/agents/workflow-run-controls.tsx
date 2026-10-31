'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { Hint } from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { errorToast, successToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { FloppyDiskIcon, PauseIcon, PlayIcon, SquareIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { WORKFLOW_LARGE_AGENT_COUNT } from '@kortix/sdk';
import { useSessionWorkflows } from '@kortix/sdk/react';
import { parseWorkflowRun, type WorkflowRun, type WorkflowRunAgent } from '../tool/tools/workflow-run';
import { useSessionPromptSend } from './session-prompt';

/**
 * One workflow run's controls, for the run card in the chat and the strip's
 * "Workflows" group: Claude Code's `/workflows` keys as buttons. Pause or
 * resume (`p`), stop the run (`x`), save its script as a workflow (`s`), and,
 * per agent row, restart (`r`). Every control goes to the box that runs the
 * run: the session that called `workflow`, or a background run's runner.
 */

/** A run's large-run warning: more agents than Claude Code's "Large workflow" threshold, or the run says so. */
export function isLargeRun(run: Pick<WorkflowRun, 'agents' | 'large' | 'maxAgents'>): boolean {
  return run.large === true || run.agents.length > WORKFLOW_LARGE_AGENT_COUNT;
}

/** The file name a run saves as: its saved name, else its title in kebab case. */
export function workflowFileName(run: Pick<WorkflowRun, 'name' | 'title'>): string {
  const base = (run.name || run.title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base || 'workflow';
}

/**
 * The live copy of a run: a background run's progress lives on its runner's box,
 * so it is read from there (`useSessionWorkflows(project, runner)`, polled while it
 * runs) and keeps updating after this session's turn ended. A foreground run is the
 * card's own metadata. `controlSessionId` is the session whose box takes the controls.
 */
export function useLiveWorkflowRun(
  projectId: string | undefined,
  sessionId: string | undefined,
  run: WorkflowRun | null,
): { run: WorkflowRun | null; controlSessionId: string | undefined; fromRunner: boolean } {
  const runner = run?.background?.sessionId;
  const { data } = useSessionWorkflows(projectId, runner, { enabled: !!projectId && !!runner });
  const live = useMemo(() => {
    if (!run || !runner || !data) return null;
    const match = data.find((candidate) => candidate.runId === run.runId) ?? (run.runId ? undefined : data[0]);
    const parsed = match ? parseWorkflowRun(match) : null;
    // The runner runs it in the foreground; this card still knows it as a background run.
    return parsed ? { ...parsed, background: run.background } : null;
  }, [run, runner, data]);
  if (!run) return { run: null, controlSessionId: undefined, fromRunner: false };
  if (runner) return { run: live ?? run, controlSessionId: runner, fromRunner: !!live };
  return { run, controlSessionId: sessionId, fromRunner: false };
}

/** The current time, every second while `active`: a live run's elapsed labels tick. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The prompt "Save" sends to the session that owns the run. */
export function useSaveWorkflowPrompt() {
  const t = useTranslations('multiAgent.workflow');
  return (run: WorkflowRun) =>
    t('savePrompt', { title: run.title || run.name || run.runId, runId: run.runId, file: `.kortix/workflows/${workflowFileName(run)}.js` });
}

export function LargeRunBadge() {
  const t = useTranslations('multiAgent.workflow');
  return (
    <Hint label={t('largeHint')} side="top">
      <Badge variant="warning" size="sm">
        <WarningIcon weight="fill" aria-hidden />
        {t('large')}
      </Badge>
    </Hint>
  );
}

export interface WorkflowRunControlsProps {
  projectId: string | undefined;
  /** The box that runs the run (the runner of a background run). */
  controlSessionId: string | undefined;
  /** The session the "Save as workflow" prompt goes to: the one that started the run. */
  ownerSessionId: string | undefined;
  run: WorkflowRun;
}

export function WorkflowRunControls({ projectId, controlSessionId, ownerSessionId, run }: WorkflowRunControlsProps) {
  const t = useTranslations('multiAgent.workflow');
  const { control } = useSessionWorkflows(projectId, controlSessionId, { enabled: false });
  const send = useSessionPromptSend(ownerSessionId);
  const savePrompt = useSaveWorkflowPrompt();
  const running = run.status === 'running';
  const canControl = !!projectId && !!controlSessionId && !!run.runId && running;
  const pending = control.isPending ? control.variables?.body.action : undefined;

  const act = (action: 'pause' | 'resume' | 'stop') =>
    control.mutate(
      { runId: run.runId, body: { action } },
      {
        onError: (error) =>
          errorToast(t(`failed.${action}`), { description: error instanceof Error ? error.message : undefined }),
      },
    );

  const save = async () => {
    if (!send) return;
    try {
      await send(savePrompt(run));
      successToast(t('saveSent'));
    } catch (error) {
      errorToast(t('saveFailed'), { description: error instanceof Error ? error.message : undefined });
    }
  };

  const buttons = [
    canControl && (
      <Hint key="pause" label={run.paused ? t('resumeHint') : t('pauseHint')} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={run.paused ? t('resume') : t('pause')}
          disabled={!!pending}
          onClick={(event) => {
            event.stopPropagation();
            act(run.paused ? 'resume' : 'pause');
          }}
        >
          {pending === 'pause' || pending === 'resume' ? (
            <Loading className="size-3 shrink-0" />
          ) : run.paused ? (
            <PlayIcon weight="fill" className="size-3 shrink-0" />
          ) : (
            <PauseIcon weight="fill" className="size-3 shrink-0" />
          )}
        </Button>
      </Hint>
    ),
    canControl && (
      <Hint key="stop" label={t('stopHint')} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('stop')}
          disabled={!!pending}
          onClick={(event) => {
            event.stopPropagation();
            act('stop');
          }}
        >
          {pending === 'stop' ? <Loading className="size-3 shrink-0" /> : <SquareIcon weight="fill" className="size-2.5 shrink-0" />}
        </Button>
      </Hint>
    ),
    // A saved workflow is a file already; any other run can become one.
    !run.name && send && run.runId && (
      <Hint key="save" label={t('saveHint')} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('save')}
          onClick={(event) => {
            event.stopPropagation();
            void save();
          }}
        >
          <FloppyDiskIcon className="size-3 shrink-0" />
        </Button>
      </Hint>
    ),
  ].filter(Boolean);

  if (buttons.length === 0) return null;
  return buttons.length === 1 ? <>{buttons}</> : <ButtonGroup>{buttons}</ButtonGroup>;
}

/** `restart_agent` for one agent row of a run, on the box that runs it. */
export function useRestartAgent(projectId: string | undefined, controlSessionId: string | undefined, run: WorkflowRun | null) {
  const t = useTranslations('multiAgent.workflow');
  const { control } = useSessionWorkflows(projectId, controlSessionId, { enabled: false });
  const enabled = !!projectId && !!controlSessionId && !!run?.runId && run.status === 'running';
  const restarting =
    control.isPending && control.variables?.body.action === 'restart_agent' ? control.variables.body.session_id : undefined;
  return {
    enabled,
    restarting,
    restart: (agent: WorkflowRunAgent) => {
      if (!enabled || !agent.sessionId || !run) return;
      control.mutate(
        { runId: run.runId, body: { action: 'restart_agent', session_id: agent.sessionId } },
        {
          onError: (error) =>
            errorToast(t('failed.restart', { label: agent.label }), {
              description: error instanceof Error ? error.message : undefined,
            }),
        },
      );
    },
  };
}
