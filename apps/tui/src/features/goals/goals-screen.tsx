/**
 * The Goals screen: the project's goals (flag `goals`), what waits on a
 * person, and the same writes the web offers, through the same API.
 *
 * This file is the data half. Reads are `@kortix/sdk/react` hooks; writes are
 * SDK calls on the goal routes (`/projects/:id/goals/*`). It renders
 * `<GoalsView/>`, which knows nothing about the SDK.
 *
 * Writes, as the web does them:
 * - `n` new goal: `createProjectGoal` (`POST /goals`). The API sets up the
 *   folder, the owner session and its heartbeat. One `goal_id` per outcome:
 *   a retry of the same text after a failure makes the same goal, not a second.
 * - `a` answer, `s` stop, `p` pause / resume, `R` start again:
 *   `useProjectGoalControl`, on the revision the screen shows. The API's
 *   `capabilities` decide which keys a goal offers. A `409` (the goal changed
 *   first) refreshes the goal and says so.
 */

import { createProjectGoal, generateSessionId, type ProjectGoal, ProjectGoalConflictError } from '@kortix/sdk';
import {
  qk,
  type ProjectGoalControlInput,
  useFeatureFlag,
  useProjectGoalControl,
  useProjectGoalFiles,
  useProjectGoals,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

/** Recorded in the goal's events when `s` carries no reason. */
export const DEFAULT_STOP_REASON = 'Stopped from the terminal.';

/** How often the time columns are recomputed. */
const CLOCK_TICK_MS = 30_000;

/** Pause and start-again reasons the goal's events record. */
const PAUSE_REASON = 'Paused from the terminal.';
const RESTART_REASON = 'Started again from the terminal.';
const CHANGED = 'The goal changed. It now shows as it is.';

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

  const queryClient = useQueryClient();
  const control = useProjectGoalControl(projectId ?? '');
  // One goal id per outcome being created: a retry of the same text reuses it.
  const pendingCreate = useRef<{ outcome: string; goalId: string } | null>(null);

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
      const text = outcome.trim();
      if (pendingCreate.current?.outcome !== text) pendingCreate.current = { outcome: text, goalId: generateSessionId() };
      const goalId = pendingCreate.current.goalId;
      run('starting…', async () => {
        const created = await createProjectGoal(projectId, { outcome: text, goalId });
        pendingCreate.current = null;
        queryClient.setQueryData(qk.project.goal(projectId, created.goalId), created.goal);
        await goalsQuery.refetch();
        setDetailId(created.goalId);
        return 'Goal started.';
      });
    },
    [projectId, run, queryClient, goalsQuery.refetch],
  );

  /** One control on one goal, through the SDK seam: a stale revision refreshes the goal and says so. */
  const runControl = useCallback(
    (id: string, label: string, done: string, input: (goal: ProjectGoal) => ProjectGoalControlInput) => {
      const goal = goals.find((entry) => goalId(entry) === id);
      if (!projectId || !goal) return;
      run(label, async () => {
        try {
          await control.mutateAsync(input(goal));
          return done;
        } catch (error) {
          if (error instanceof ProjectGoalConflictError) return CHANGED;
          throw error;
        }
      });
    },
    [projectId, goals, control.mutateAsync, run],
  );

  // One answer id per goal and text: resending the same answer after a failure delivers it once.
  const pendingAnswer = useRef<{ key: string; answerId: string } | null>(null);
  const onReply = useCallback<GoalsViewProps['onReply']>(
    (id, text) => {
      const key = `${id}\n${text}`;
      if (pendingAnswer.current?.key !== key) pendingAnswer.current = { key, answerId: generateSessionId() };
      const answerId = pendingAnswer.current.answerId;
      runControl(id, 'sending…', 'Answer sent to the goal owner.', (goal) => ({ goal, action: 'answer', text, answerId }));
    },
    [runControl],
  );
  const onStop = useCallback<GoalsViewProps['onStop']>(
    (id, reason) => runControl(id, 'stopping…', 'Goal stopped.', (goal) => ({ goal, action: 'stop', reason: reason || DEFAULT_STOP_REASON })),
    [runControl],
  );
  const onPause = useCallback<GoalsViewProps['onPause']>(
    (id) => runControl(id, 'pausing…', 'Goal paused.', (goal) => ({ goal, action: 'pause', reason: PAUSE_REASON })),
    [runControl],
  );
  const onResume = useCallback<GoalsViewProps['onResume']>(
    (id) => runControl(id, 'resuming…', 'Goal resumed.', (goal) => ({ goal, action: 'resume' })),
    [runControl],
  );
  const onRestart = useCallback<GoalsViewProps['onRestart']>(
    (id) => runControl(id, 'starting again…', 'Goal started again.', (goal) => ({ goal, action: 'restart', reason: RESTART_REASON })),
    [runControl],
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
        <text fg={theme.faint}>No workspace open. Type /workspaces to pick one.</text>
      </box>
    );
  }
  if (!flag.isLoading && !flag.enabled) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>Goals are off for this workspace (flag `goals`).</text>
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
      onPause={onPause}
      onResume={onResume}
      onRestart={onRestart}
      onOpenWeb={onOpenWeb}
      onRefresh={onRefresh}
      onBack={onBack}
    />
  );
}
