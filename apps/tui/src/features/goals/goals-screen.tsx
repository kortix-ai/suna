/**
 * The Goals screen: the project's goals (flag `goals`), what waits on a
 * person, and the few writes the web offers.
 *
 * This file is the data half. Reads are `@kortix/sdk/react` hooks; writes are
 * SDK functions. It renders `<GoalsView/>`, which knows nothing about the SDK.
 *
 * Writes, as the web does them:
 * - `n` new goal: a new session whose first message is the outcome plus
 *   `MAKE_GOAL_PROMPT` (`useStartGoal`, `packages/ui/src/internal/goals`). The
 *   agent writes GOAL.md. There is no "create goal" call in the SDK: a goal is
 *   a folder in Files that an agent authors.
 * - `a` answer: `replyToProjectGoal` queues the text into the owner session.
 * - `s` stop: `stopProjectGoal` writes GOAL.md + log.md and drops the heartbeat.
 * There is no pause, resume or complete write: those are the agent's.
 */

import {
  MAKE_GOAL_PROMPT,
  type ProjectGoal,
  replyToProjectGoal,
  stopProjectGoal,
} from '@kortix/sdk';
import { useFeatureFlag, useProjectGoalFiles, useProjectGoals } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import {
  type GoalDetail,
  goalId,
  sortRows,
  toGoalDetail,
  toGoalRow,
  webGoalUrl,
} from './goals-model.ts';
import { GoalsView, type GoalsViewProps } from './goals-view.tsx';

export interface GoalsScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

/** Recorded in GOAL.md and log.md when `s` carries no reason. */
export const DEFAULT_STOP_REASON = 'Stopped from the terminal.';

/** How often the time columns are recomputed. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export function GoalsScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession,
  onToast,
}: GoalsScreenProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const flag = useFeatureFlag(projectId, 'goals');
  const goalsQuery = useProjectGoals(flag.enabled ? projectId : null);
  const goals = useMemo<ProjectGoal[]>(() => goalsQuery.data ?? [], [goalsQuery.data]);
  const rows = useMemo(() => sortRows(goals.map(toGoalRow)), [goals]);

  const detailGoal = useMemo(
    () => goals.find((goal) => goalId(goal) === detailId) ?? null,
    [goals, detailId],
  );
  // `null` until Enter opens a goal: an idle list reads no goal folder.
  const filesQuery = useProjectGoalFiles(projectId, detailGoal);
  const detail = useMemo<GoalDetail | null>(
    () =>
      detailGoal
        ? toGoalDetail(detailGoal, {
            loading: filesQuery.isLoading,
            verification: filesQuery.data?.verification ?? null,
            log: filesQuery.data?.log ?? null,
          })
        : null,
    [detailGoal, filesQuery.data, filesQuery.isLoading],
  );

  const run = useCallback(
    (label: string, work: () => Promise<unknown>) => {
      setBusy(label);
      void work()
        .then((message) => {
          if (typeof message === 'string' && message) onToast(message);
        })
        .catch((error: unknown) => onToast(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [onToast],
  );

  const onCreate = useCallback<GoalsViewProps['onCreate']>(
    (outcome) => {
      if (!projectId) return;
      run('starting…', async () => {
        const created = await kortix().projects.createSession(projectId, {
          pending_prompt: {
            text: `${outcome.trim()}\n\n${MAKE_GOAL_PROMPT}`,
            agent: null,
            model: null,
            variant: null,
          },
        });
        onOpenSession(created.session_id);
      });
    },
    [projectId, run, onOpenSession],
  );

  const onReply = useCallback<GoalsViewProps['onReply']>(
    (id, text) => {
      const goal = goals.find((entry) => goalId(entry) === id);
      if (!projectId || !goal) return;
      run('sending…', async () => {
        await replyToProjectGoal(projectId, goal, text);
        return 'Answer sent to the goal owner.';
      });
    },
    [projectId, goals, run],
  );

  const onStop = useCallback<GoalsViewProps['onStop']>(
    (id, reason) => {
      const goal = goals.find((entry) => goalId(entry) === id);
      if (!projectId || !goal) return;
      run('stopping…', async () => {
        await stopProjectGoal(projectId, goal, reason || DEFAULT_STOP_REASON);
        await goalsQuery.refetch();
        return 'Goal stopped.';
      });
    },
    [projectId, goals, goalsQuery.refetch, run],
  );

  const onOpenWeb = useCallback<GoalsViewProps['onOpenWeb']>(
    (id) => {
      const goal = goals.find((entry) => goalId(entry) === id);
      if (!projectId || !goal) return;
      void openUrl(webGoalUrl(webBaseUrl, projectId, goal))
        .then(() => onToast('Opened in the browser.'))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [projectId, goals, webBaseUrl, onToast],
  );

  const onRefresh = useCallback(() => {
    setBusy('refreshing…');
    void goalsQuery
      .refetch()
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [goalsQuery.refetch, onToast]);

  if (!projectId) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected.</text>
      </box>
    );
  }
  if (!flag.isLoading && !flag.enabled) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>Goals are off for this project (flag `goals`).</text>
      </box>
    );
  }

  return (
    <GoalsView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={flag.isLoading || goalsQuery.isLoading}
      errorMessage={goalsQuery.isError ? errorText(goalsQuery.error) : null}
      busyMessage={busy}
      detail={detail}
      emptyHint="n  start a goal"
      onOpenDetails={setDetailId}
      onOpenSession={onOpenSession}
      onCreate={onCreate}
      onReply={onReply}
      onStop={onStop}
      onOpenWeb={onOpenWeb}
      onRefresh={onRefresh}
      onBack={onBack}
    />
  );
}
