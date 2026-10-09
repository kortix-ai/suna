// Session events → the notifier (KRTX-1742 design §3.1). A turn completed or
// failed, or the agent asks a question or a permission: decide who is told,
// then hand it to `deliver` (notifier.ts), which writes one inbox row per
// recipient and sends push and email by their preferences.
//
// What only projects/ can read — the person who prompted the turn, the
// session's origin class, the trigger watchers — is resolved there
// (projects/lib/notification-recipients.ts) and travels on the event. Callers
// fire and forget: `notifySessionEvent` never throws.
//
// A turn end notifies from whoever closed the turn: the daemon's relay
// (routes/turn-stream-handlers.ts), or the control plane — turn recovery,
// inbox admission, the reaper (projects/lib/closed-turn-notification.ts).
// Only the caller that won the token-scoped close notifies.
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { logger } from '../lib/logger';
import {
  ABORT_END_ERROR_NAMES,
  isRequestedStopName,
  type SandboxTurnCompletionOutcome,
  type SessionTurnEndReason,
} from '../projects/session-turn-ledger';
import { filterSessionRecipients, loadSessionAccessRows, personsAmong, type SessionAccessRow } from './access';
import { clip, INBOX_BODY_MAX_CHARS } from './inbox-store';
import { deliver, type DeliverInput, type NotifierDeps } from './notifier';
import { sessionWatchersOf, type SessionWatchers } from './watchers';

export type SessionPushEventType = 'completion' | 'error' | 'question' | 'permission';

/**
 * - `attended`: a person runs it from Kortix (web, mobile, CLI, SDK).
 * - `channel`: Slack, Teams, email or Telegram; the thread is the conversation.
 * - `unattended`: a trigger or schedule runs it.
 */
export type SessionOriginClass = 'attended' | 'channel' | 'unattended';

export interface SessionPushEvent {
  type: SessionPushEventType;
  sessionId: string;
  projectId: string;
  /** First question text, for `question` events. */
  question?: string;
  /** The error message, for `error` events. */
  errorMessage?: string | null;
  /** The ask's request id: one row per recipient per question or permission. */
  requestId?: string | null;
  /** The ended turn's message id: one row per recipient per turn. */
  turnMessageId?: string | null;
  /** The person whose prompt started the turn; null for a channel, trigger or agent prompt. */
  prompterUserId?: string | null;
  /** Defaults to `attended`. */
  originClass?: SessionOriginClass;
  /** A coordinator-spawned worker session. */
  isChild?: boolean;
  /** The Slack/Teams thread posted the question itself. */
  threadCarriesAsk?: boolean;
  /** Who follows the trigger, for an ask in an unattended session. */
  triggerWatcherIds?: readonly string[];
  /** Tell exactly these users instead of the computed set. Muted users are still removed. */
  recipients?: readonly string[];
}

export type SessionPushOutcome = {
  reason: 'no_session' | 'no_recipient' | 'no_access' | 'failed' | 'delivered';
  recipients: string[];
};

const KIND: Record<SessionPushEventType, NotificationKindName> = {
  completion: 'turn_done',
  error: 'turn_error',
  question: 'question',
  permission: 'permission',
};

/** The push body keeps today's 140-character question line. */
export const QUESTION_TEXT_MAX_CHARS = 140;

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

/**
 * Which notification a turn the control plane closed earns: turn recovery on
 * a turn read, inbox admission, or the reaper. Same rules as
 * `turnEndPushType`, keyed by the ledger's end reason. Only the caller whose
 * close won (`clearSandboxTurn` returned true) may ask, so the relay and these
 * paths never both notify one turn.
 */
export function closedTurnPushType(input: {
  reason: SessionTurnEndReason;
  childSession?: boolean;
  /** A queued prompt was promoted by this close: the session keeps running. */
  promoted?: boolean;
  /**
   * The closed turns' `session_turns.end_error` names. A Stop or a queue
   * interrupt ends as OpenCode's abort, which the daemon reports `failed`;
   * the stop mark (`markTurnStopRequested`) is what says it was asked for.
   */
  endErrorNames?: readonly (string | null)[];
}): 'completion' | 'error' | null {
  if (input.childSession) return null;
  if (input.reason === 'completed') return input.promoted ? null : 'completion';
  if (input.reason !== 'failed') return null;
  const names = input.endErrorNames ?? [];
  const stopped = (name: string | null) => isRequestedStopName(name) || ABORT_END_ERROR_NAMES.includes(name ?? '');
  return names.length > 0 && names.every(stopped) ? null : 'error';
}

/** `metadata.custom_name`, else the generated `metadata.name`, else null. */
export function sessionTitleOf(metadata: unknown): string | null {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((value): value is string => typeof value === 'string') ?? null;
}

/**
 * Who is told, before the access check (design §3.1). `watchers.watching` is
 * the creator (unless muted) plus every unmuted row; muted users are always
 * removed. `pushAllowed` is false when a channel thread already carried the
 * event: the inbox row is the record, with no push and no email.
 */
export function sessionEventAudience(
  event: SessionPushEvent,
  watchers: SessionWatchers,
): { recipients: string[]; pushAllowed: boolean } {
  const origin = event.isChild ? 'child' : (event.originClass ?? 'attended');
  const ask = event.type === 'question' || event.type === 'permission';
  const prompter = event.prompterUserId ? [event.prompterUserId] : [];
  const everyone = [...prompter, ...watchers.watching];
  const quiet = origin === 'channel' && (!ask || event.threadCarriesAsk === true);
  let named: readonly string[];
  if (event.recipients) named = event.recipients;
  else if (!ask) named = origin === 'child' ? [] : origin === 'attended' ? everyone : prompter;
  else if (origin === 'unattended') named = [...prompter, ...(event.triggerWatcherIds ?? [])];
  else named = quiet ? prompter : everyone;
  return {
    recipients: [...new Set(named)].filter((id) => !!id && !watchers.muted.has(id)),
    pushAllowed: !quiet,
  };
}

function bodyOf(event: SessionPushEvent): string {
  if (event.type === 'question') return clip(event.question ?? '', QUESTION_TEXT_MAX_CHARS);
  if (event.type === 'error') return clip(event.errorMessage ?? '', INBOX_BODY_MAX_CHARS);
  return '';
}

function dedupeKeyOf(event: SessionPushEvent): string | null {
  if (event.type === 'question' || event.type === 'permission') {
    return event.requestId ? `${event.type}:${event.sessionId}:${event.requestId}` : null;
  }
  return event.turnMessageId ? `turn:${event.sessionId}:${event.turnMessageId}` : null;
}

export interface SessionNotifierDeps {
  loadSession(sessionId: string): Promise<SessionAccessRow | null>;
  watchers(sessionId: string, createdBy: string | null): Promise<SessionWatchers>;
  /** The people (account members) among `userIds` who may open the session now. */
  mayOpen(session: SessionAccessRow, userIds: readonly string[]): Promise<string[]>;
  /** The people among `ids`: the members of the account. */
  personsAmong(accountId: string, ids: readonly string[]): Promise<string[]>;
  deliver(input: DeliverInput): Promise<unknown>;
  logger: Pick<Console, 'warn'>;
}

export function createSessionNotifier(deps: SessionNotifierDeps) {
  return async function notify(event: SessionPushEvent): Promise<SessionPushOutcome> {
    try {
      const session = await deps.loadSession(event.sessionId);
      if (!session || session.projectId !== event.projectId) return { reason: 'no_session', recipients: [] };
      const audience = sessionEventAudience(event, await deps.watchers(session.sessionId, session.createdBy));
      if (audience.recipients.length === 0) return { reason: 'no_recipient', recipients: [] };
      // A member who left, lost the project, or lost a share keeps nothing:
      // no title and no question text (KRTX-1722, session level since KRTX-1742).
      const recipients = await deps.mayOpen(session, audience.recipients);
      if (recipients.length === 0) return { reason: 'no_access', recipients: [] };
      // Only a person is named the actor, never a service account.
      const prompter = event.prompterUserId;
      const [actorUserId = null] = prompter ? await deps.personsAmong(session.accountId, [prompter]) : [];
      await deps.deliver({
        kind: KIND[event.type],
        accountId: session.accountId,
        projectId: session.projectId,
        sessionId: session.sessionId,
        title: sessionTitleOf(session.metadata) ?? '',
        body: bodyOf(event),
        actorUserId,
        dedupeKey: dedupeKeyOf(event),
        recipients,
        pushAllowed: audience.pushAllowed,
      });
      return { reason: 'delivered', recipients };
    } catch (err) {
      deps.logger.warn('[notify] session event failed', {
        type: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { reason: 'failed', recipients: [] };
    }
  };
}

/**
 * Tell the people a session event is for. Never throws. `notifierDeps`
 * replaces the delivery wiring (DB suites inject the senders only).
 */
export function notifySessionEvent(event: SessionPushEvent, notifierDeps?: NotifierDeps): Promise<SessionPushOutcome> {
  return createSessionNotifier({
    loadSession: async (sessionId) => (await loadSessionAccessRows([sessionId])).get(sessionId) ?? null,
    watchers: sessionWatchersOf,
    mayOpen: filterSessionRecipients,
    personsAmong,
    deliver: (input) => deliver(input, notifierDeps),
    logger,
  })(event).then((outcome) => {
    // One line per event, so a missing notification leaves a trace. Never
    // log message bodies or question text.
    if (outcome.reason !== 'failed') {
      logger.info('[notify] session event', {
        type: event.type,
        sessionId: event.sessionId,
        reason: outcome.reason,
        recipients: outcome.recipients.length,
      });
    }
    return outcome;
  });
}
