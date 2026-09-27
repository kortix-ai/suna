// Session push notifications: the server tells the session creator's devices
// that a turn completed, failed, or needs an answer. The app may be closed, so
// the API detects the event (routes/turn-stream.ts, routes/turn-questions.ts)
// and sends through Expo. Callers fire and forget: `notifySessionEvent` never
// throws and never runs on the relay's response path.
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { ABORT_END_ERROR_NAMES, type SandboxTurnCompletionOutcome } from '../projects/sandbox-turn-lifecycle';
import { db } from '../shared/db';
import { pushDeviceTokenStore, type PushDeviceTokenRow, type PushDeviceTokenStore } from './device-tokens';
import { sendExpoPushMessages, type ExpoPushMessage, type ExpoPushResult } from './expo-push';

export type SessionPushEventType = 'completion' | 'error' | 'question' | 'permission';

export interface SessionPushEvent {
  type: SessionPushEventType;
  sessionId: string;
  projectId: string;
  /** First question text, for `question` events. */
  question?: string;
}

export interface SessionPushTarget {
  createdBy: string | null;
  title: string | null;
}

export interface SessionPushDeps {
  enabled: boolean;
  loadSession(sessionId: string, projectId: string): Promise<SessionPushTarget | null>;
  store: Pick<PushDeviceTokenStore, 'listByUser' | 'deleteTokens'>;
  send(messages: ExpoPushMessage[], store: Pick<PushDeviceTokenStore, 'deleteTokens'>): Promise<ExpoPushResult>;
  /** Receives failure warnings. Defaults to `console`. */
  logger?: Pick<Console, 'warn'>;
}

export type SessionPushOutcome =
  | { sent: 0; reason: 'disabled' | 'no_session' | 'no_recipient' | 'no_devices' | 'failed' }
  | { sent: number; reason: 'sent'; result: ExpoPushResult };

export const DEFAULT_PUSH_TITLE = 'Kortix';
export const QUESTION_TEXT_MAX_CHARS = 140;

const BODIES: Record<Exclude<SessionPushEventType, 'question'>, string> = {
  completion: 'Session complete. Tap to see the result.',
  permission: 'Kortix needs your approval to continue.',
  error: 'The session stopped with an error.',
};

const SOUNDS: Record<SessionPushEventType, { sound: string; channelId: string }> = {
  completion: { sound: 'kortix_complete.wav', channelId: 'session-complete' },
  question: { sound: 'kortix_attention.wav', channelId: 'session-attention' },
  permission: { sound: 'kortix_attention.wav', channelId: 'session-attention' },
  error: { sound: 'kortix_error.wav', channelId: 'session-error' },
};
const SILENT_CHANNEL_ID = 'session-silent';

const PREFERENCE: Record<SessionPushEventType, keyof PushDeviceTokenRow> = {
  completion: 'onCompletion',
  error: 'onError',
  question: 'onQuestion',
  permission: 'onPermission',
};

/** Collapse whitespace and cut to `QUESTION_TEXT_MAX_CHARS` characters. */
export function truncateQuestion(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= QUESTION_TEXT_MAX_CHARS) return flat;
  return `${chars.slice(0, QUESTION_TEXT_MAX_CHARS - 1).join('').trimEnd()}…`;
}

export function pushBody(type: SessionPushEventType, question?: string): string {
  if (type === 'question') {
    const text = question ? truncateQuestion(question) : '';
    return text ? `Kortix has a question: ${text}` : 'Kortix has a question.';
  }
  return BODIES[type];
}

/** Rows whose stored preferences allow `type`. */
export function devicesForEvent(rows: readonly PushDeviceTokenRow[], type: SessionPushEventType) {
  return rows.filter((row) => row.provider === 'expo' && row.enabled && row[PREFERENCE[type]] === true);
}

export function buildSessionPushMessages(
  event: SessionPushEvent,
  title: string | null,
  rows: readonly PushDeviceTokenRow[],
): ExpoPushMessage[] {
  const heading = title?.trim() || DEFAULT_PUSH_TITLE;
  const body = pushBody(event.type, event.question);
  const data = { type: event.type, projectId: event.projectId, sessionId: event.sessionId };
  return devicesForEvent(rows, event.type).map((row) => ({
    to: row.token,
    title: heading,
    body,
    data,
    ...(row.playSound ? SOUNDS[event.type] : { sound: null, channelId: SILENT_CHANNEL_ID }),
    priority: 'high',
  }));
}

/**
 * Which push a sandbox turn end earns. Only an end that closed a turn in this
 * call notifies: a replay, a duplicate of an already-closed turn, an identity
 * mismatch, or a retryable error sends nothing. A user abort sends nothing, and
 * neither does a coordinator-spawned child session (its parent reports). An
 * idle end that promoted a queued prompt is not a completion: the session
 * keeps running. Error pushes ignore promotion.
 */
export function turnEndPushType(input: {
  outcome: SandboxTurnCompletionOutcome;
  status: 'idle' | 'error';
  errorName?: string | null;
  childSession?: boolean;
  /** A queued prompt was promoted by this end: the session keeps running. */
  promoted?: boolean;
}): 'completion' | 'error' | null {
  if (input.childSession) return null;
  if (input.outcome !== 'closed') return null;
  if (input.status === 'idle') return input.promoted ? null : 'completion';
  if (input.errorName && ABORT_END_ERROR_NAMES.includes(input.errorName)) return null;
  return 'error';
}

export function createSessionNotifier(deps: SessionPushDeps) {
  return async function notify(event: SessionPushEvent): Promise<SessionPushOutcome> {
    try {
      if (!deps.enabled) return { sent: 0, reason: 'disabled' };
      const session = await deps.loadSession(event.sessionId, event.projectId);
      if (!session) return { sent: 0, reason: 'no_session' };
      if (!session.createdBy) return { sent: 0, reason: 'no_recipient' };
      const rows = await deps.store.listByUser(session.createdBy);
      const messages = buildSessionPushMessages(event, session.title, rows);
      if (messages.length === 0) return { sent: 0, reason: 'no_devices' };
      const result = await deps.send(messages, deps.store);
      return { sent: messages.length, reason: 'sent', result };
    } catch (err) {
      (deps.logger ?? console).warn('[push] session notification failed', {
        type: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { sent: 0, reason: 'failed' };
    }
  };
}

async function loadSessionTarget(sessionId: string, projectId: string): Promise<SessionPushTarget | null> {
  const [row] = await db
    .select({ createdBy: projectSessions.createdBy, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  // `metadata.name` is the session title (owned by session-title-generate.ts).
  const name = (row.metadata as Record<string, unknown> | null)?.name;
  return { createdBy: row.createdBy, title: typeof name === 'string' ? name : null };
}

let defaultNotifier: ReturnType<typeof createSessionNotifier> | null = null;

/** Notify the session creator's devices. Never throws. */
export function notifySessionEvent(event: SessionPushEvent): Promise<SessionPushOutcome> {
  defaultNotifier ??= createSessionNotifier({
    enabled: config.PUSH_NOTIFICATIONS_ENABLED,
    loadSession: loadSessionTarget,
    store: pushDeviceTokenStore(),
    send: (messages, store) =>
      sendExpoPushMessages(messages, { accessToken: config.EXPO_ACCESS_TOKEN || undefined, store }),
  });
  return defaultNotifier(event);
}
