// Session reminders — scheduled prompts into one session.
//
// A reminder wakes its session on a schedule with the same prompt ("did the email
// arrive?") until someone stops it. It lives in the database, not kortix.yaml,
// so an agent can create one mid-task with one call. Each fire re-prompts the
// reminder's own session; it never creates a session. A fire into a deleted or
// failed session pauses the reminder.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** `active` = scheduled; `paused` = off; `done` = a one-shot reminder that fired. */
export type SessionReminderState = 'active' | 'paused' | 'done';

export interface SessionReminder {
  /** `reminder.<hex>` — pass it to update/remove. */
  id: string;
  session_id: string | null;
  name: string | null;
  prompt: string;
  /** Canonical period (`30m`, `1h`, `1d`), or null for a cron or one-shot reminder. */
  every: string | null;
  every_seconds: number | null;
  /** Cron expression, or null. */
  cron: string | null;
  timezone: string;
  /** ISO-8601 instant of a one-shot reminder, or null for a recurring reminder. */
  at: string | null;
  state: SessionReminderState;
  next_fire_at: string | null;
  last_fired_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** User id of the creator. */
  created_by: string | null;
  created_at: string | null;
}

/**
 * When the reminder fires. Give `every` or `cron` for a recurring reminder; `at` or
 * `in` sets the first fire (alone, the reminder fires once). Durations are `30m`,
 * `24h`, `2d`, or whole seconds. A recurring reminder fires at most once per 5m.
 */
export interface CreateSessionReminderInput {
  prompt: string;
  name?: string;
  every?: string | number;
  cron?: string;
  /** IANA timezone for `cron`. Default `UTC`. */
  timezone?: string;
  at?: string;
  in?: string | number;
}

export interface UpdateSessionReminderInput {
  enabled: boolean;
}

export async function listSessionReminders(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ reminders: SessionReminder[] }>(`/projects/${projectId}/sessions/${sessionId}/reminders`),
  );
}

export async function createSessionReminder(
  projectId: string,
  sessionId: string,
  input: CreateSessionReminderInput,
) {
  return unwrap(
    await backendApi.post<SessionReminder>(`/projects/${projectId}/sessions/${sessionId}/reminders`, input),
  );
}

export async function updateSessionReminder(
  projectId: string,
  sessionId: string,
  reminderId: string,
  input: UpdateSessionReminderInput,
) {
  return unwrap(
    await backendApi.patch<SessionReminder>(
      `/projects/${projectId}/sessions/${sessionId}/reminders/${reminderId}`,
      input,
    ),
  );
}

export async function deleteSessionReminder(projectId: string, sessionId: string, reminderId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/sessions/${sessionId}/reminders/${reminderId}`),
  );
}

/** One reminder, addressed by the session it belongs to. */
export interface SessionReminderRef {
  sessionId: string;
  reminderId: string;
}

/** What a batch did: the reminders it changed, and each one it could not, with why. */
export interface SessionReminderBatchResult {
  done: SessionReminderRef[];
  failed: { reminder: SessionReminderRef; error: unknown }[];
}

/**
 * Requests a batch keeps in flight. A batch of 100 must not open 100
 * connections against one API, nor take 100 round trips in a row.
 */
const BATCH_CONCURRENCY = 4;

/** Runs `run` for every reminder, `BATCH_CONCURRENCY` at a time; one failure never stops the rest. */
async function runBatch(
  reminders: readonly SessionReminderRef[],
  run: (reminder: SessionReminderRef) => Promise<unknown>,
): Promise<SessionReminderBatchResult> {
  const outcomes: ({ ok: true } | { ok: false; error: unknown })[] = new Array(reminders.length);
  let next = 0;
  const worker = async () => {
    while (next < reminders.length) {
      const index = next++;
      try {
        await run(reminders[index]!);
        outcomes[index] = { ok: true };
      } catch (error) {
        outcomes[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, reminders.length) }, worker));
  const result: SessionReminderBatchResult = { done: [], failed: [] };
  reminders.forEach((reminder, index) => {
    const outcome = outcomes[index]!;
    if (outcome.ok) result.done.push(reminder);
    else result.failed.push({ reminder, error: outcome.error });
  });
  return result;
}

/** Pause or resume many reminders, across sessions. Reports each reminder; never throws for one. */
export function updateSessionReminders(
  projectId: string,
  reminders: readonly SessionReminderRef[],
  input: UpdateSessionReminderInput,
) {
  return runBatch(reminders, (r) => updateSessionReminder(projectId, r.sessionId, r.reminderId, input));
}

/** Remove many reminders, across sessions. Reports each reminder; never throws for one. */
export function deleteSessionReminders(projectId: string, reminders: readonly SessionReminderRef[]) {
  return runBatch(reminders, (r) => deleteSessionReminder(projectId, r.sessionId, r.reminderId));
}

/** A reminder as the project list returns it: plus its session's display name. */
export interface ProjectReminder extends SessionReminder {
  session_name: string | null;
}

/**
 * Every reminder in a project on a session the caller can open, soonest
 * active first, then paused, then done. At most 200.
 */
export async function listProjectReminders(projectId: string) {
  return unwrap(await backendApi.get<{ reminders: ProjectReminder[] }>(`/projects/${projectId}/reminders`));
}
