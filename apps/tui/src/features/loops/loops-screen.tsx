/**
 * The Loops screen: the open session's reminders (SPEC §5).
 *
 * This file is the data half. Reads and the pause/resume, run and delete
 * writes are `useSessionReminders` (`@kortix/sdk/react`); create is
 * `kortix().session(p, s).reminders.create`. It renders `<LoopsView/>`.
 *
 * Gated on the project's `reminders` flag, as the web is
 * (`session-reminders-indicator.tsx`). A loop belongs to one session, so the
 * screen needs a `sessionId`.
 */

import type { SessionReminder } from '@kortix/sdk';
import { useFeatureFlag, useSessionReminders } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { theme } from '../../theme.ts';
import { Spinner } from '../../ui/index.ts';
import { type LoopRow, LoopsView } from './loops-view.tsx';
import { parseSchedule } from './schedule.ts';

export interface LoopsScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin. Carried for the caller; Loops has no browser action. */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

/** How often the next-run column is recomputed. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}

function epochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** The schedule as one phrase: `every 1h`, `cron 0 9 * * *`, `once 2026-11-02 09:00`. */
export function scheduleText(reminder: SessionReminder): string {
  if (reminder.every) return `every ${reminder.every}`;
  if (reminder.cron) return `cron ${reminder.cron}`;
  if (reminder.at) return `once ${reminder.at.slice(0, 16).replace('T', ' ')}`;
  return 'no schedule';
}

export function toRow(reminder: SessionReminder): LoopRow {
  const firstLine = reminder.prompt.split('\n')[0] ?? '';
  return {
    id: reminder.id,
    title: reminder.name || firstLine || reminder.id,
    prompt: reminder.prompt,
    schedule: scheduleText(reminder),
    timezone: reminder.timezone,
    state: reminder.state,
    nextMs: epochMs(reminder.next_fire_at),
    lastMs: epochMs(reminder.last_fired_at),
    lastStatus: reminder.last_status,
    lastError: reminder.last_error,
  };
}

export function LoopsScreen({
  projectId,
  accountId: _accountId,
  sessionId,
  focused,
  width,
  height,
  webBaseUrl: _webBaseUrl,
  onBack,
  onOpenSession: _onOpenSession,
  onToast,
}: LoopsScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const flag = useFeatureFlag(projectId, 'reminders');
  const loops = useSessionReminders(flag.enabled ? projectId : null, sessionId);
  const rows = useMemo(() => (loops.data?.reminders ?? []).map(toRow), [loops.data]);

  const run = useCallback(
    (label: string, done: string, work: () => Promise<unknown>) => {
      setBusy(label);
      void work()
        .then(() => onToast(done))
        .catch((error: unknown) => onToast(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [onToast],
  );

  const create = useCallback(
    (input: { prompt: string; schedule: string }) => {
      if (!projectId || !sessionId) return;
      const parsed = parseSchedule(input.schedule);
      if (!parsed.ok) return onToast(parsed.reason, 'error');
      run('creating…', 'Loop created.', async () => {
        await kortix()
          .session(projectId, sessionId)
          .reminders.create({ prompt: input.prompt, ...parsed.schedule });
        await loops.refetch();
      });
    },
    [projectId, sessionId, run, loops.refetch, onToast],
  );

  const toggle = useCallback(
    (row: LoopRow) => {
      const enable = row.state !== 'active';
      if (row.state === 'done') return onToast('This loop already ran. Create a new one.', 'error');
      run(enable ? 'resuming…' : 'pausing…', enable ? 'Loop resumed.' : 'Loop paused.', () =>
        loops.update.mutateAsync({ reminderId: row.id, enabled: enable }),
      );
    },
    [loops.update, run, onToast],
  );

  const runNow = useCallback(
    (row: LoopRow) =>
      run('running…', 'Loop sent to the session.', () => loops.run.mutateAsync(row.id)),
    [loops.run, run],
  );

  const remove = useCallback(
    (row: LoopRow) =>
      run('deleting…', 'Loop deleted.', () => loops.remove.mutateAsync(row.id)),
    [loops.remove, run],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void loops
      .refetch()
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [loops.refetch, onToast]);

  if (!projectId) return <text fg={theme.faint}>No project selected.</text>;
  if (!sessionId) return <text fg={theme.faint}>Open a session first.</text>;
  if (flag.isLoading) return <Spinner label="checking Loops" />;
  if (!flag.enabled) {
    return <text fg={theme.faint}>Loops are off: the project's reminders feature is not enabled.</text>;
  }

  return (
    <LoopsView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={loops.isLoading}
      errorMessage={loops.isError ? errorText(loops.error) : null}
      busyMessage={busy}
      onCreate={create}
      onToggle={toggle}
      onRun={runNow}
      onDelete={remove}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
