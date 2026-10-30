/**
 * question-reminder — the local notification for a question nobody answered
 * (KRTX-2138). The hook `hooks/useQuestionReminders.ts` runs these rules.
 *
 * The server pushes "Kortix has a question" when the question is asked
 * (`push-payload.ts`). This reminder follows that push: it fires once, 60 s
 * later, only while the question is still pending.
 *
 * Rules:
 * - One reminder per question request id. An id is never scheduled twice, also
 *   after a stale hydrate re-adds it.
 * - Scheduled only while a session is bound to the live stream
 *   (`SandboxContext`): every question the stream adds belongs to it.
 *   Leaving that session (project home unbinds it, another session binds)
 *   keeps the reminder: the user left the question, the case it is for. No
 *   stream then sees an answer from another surface, so the reminder can
 *   fire for a question answered there; the tap shows it answered.
 * - A question that leaves the SDK's pending store (answered or dismissed on
 *   any surface, the turn stopped, sign-out) cancels its reminder.
 * - The `enabled` and `onQuestion` switches off: nothing is scheduled, and
 *   scheduled reminders are cancelled.
 * - Foreground on that session: the shared foreground handler hides it
 *   (`shouldPresentInForeground`, the same `data` as a question push).
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import { deliveryForKind } from './push';

export const QUESTION_REMINDER_SECONDS = 60;
export const QUESTION_REMINDER_BODY = 'You need to answer the question.';
const IDENTIFIER_PREFIX = 'question-reminder:';

/** Bound on remembered question ids; the oldest are forgotten first. */
export const MAX_REMEMBERED_QUESTIONS = 500;

/** The project session a reminder opens. */
export interface ReminderSession {
  projectId: string;
  sessionId: string;
}

export interface ReminderTracker {
  /** Question request ids already handled: never scheduled again. */
  seen: Set<string>;
  /** Scheduled reminders by question request id. */
  scheduled: Map<string, ReminderSession>;
}

export interface ReminderPlan {
  schedule: { requestId: string; session: ReminderSession }[];
  /** Question request ids whose reminder to cancel. */
  cancel: string[];
}

export function createReminderTracker(): ReminderTracker {
  return { seen: new Set(), scheduled: new Map() };
}

export function reminderIdentifier(requestId: string): string {
  return `${IDENTIFIER_PREFIX}${requestId}`;
}

export function isReminderIdentifier(identifier: string): boolean {
  return identifier.startsWith(IDENTIFIER_PREFIX);
}

function remember(tracker: ReminderTracker, requestId: string): void {
  tracker.seen.add(requestId);
  if (tracker.seen.size > MAX_REMEMBERED_QUESTIONS) {
    const oldest = tracker.seen.values().next().value;
    if (oldest !== undefined) tracker.seen.delete(oldest);
  }
}

/**
 * Record the current pending questions in `tracker` and return what to
 * schedule and cancel. Call on every change of the pending store, the bound
 * session, or the switches.
 */
export function planQuestionReminders(
  tracker: ReminderTracker,
  input: { pendingIds: readonly string[]; bound: ReminderSession | null; enabled: boolean }
): ReminderPlan {
  const pending = new Set(input.pendingIds);
  const plan: ReminderPlan = { schedule: [], cancel: [] };

  for (const [requestId, session] of tracker.scheduled) {
    if (pending.has(requestId) && input.enabled) continue;
    tracker.scheduled.delete(requestId);
    plan.cancel.push(requestId);
  }

  for (const requestId of pending) {
    if (tracker.seen.has(requestId)) continue;
    remember(tracker, requestId);
    if (!input.enabled || !input.bound) continue;
    tracker.scheduled.set(requestId, input.bound);
    plan.schedule.push({ requestId, session: input.bound });
  }

  return plan;
}

/**
 * The `scheduleNotificationAsync` request. `data` matches a question push, so
 * the tap (`handleResponse`) and the foreground rule treat it the same way.
 */
export function questionReminderRequest(input: {
  requestId: string;
  session: ReminderSession;
  playSound: boolean;
}) {
  const { channelId, iosSound } = deliveryForKind('question', input.playSound);
  return {
    identifier: reminderIdentifier(input.requestId),
    content: {
      title: 'Kortix',
      body: QUESTION_REMINDER_BODY,
      sound: iosSound ?? (false as const),
      data: {
        kind: 'question',
        type: 'question',
        projectId: input.session.projectId,
        sessionId: input.session.sessionId,
        reminder: true,
      },
    },
    trigger: { type: 'timeInterval' as const, seconds: QUESTION_REMINDER_SECONDS, repeats: false, channelId },
  };
}
