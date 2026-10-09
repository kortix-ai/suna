// The session push from before KRTX-1742, kept for a project whose
// `notification_center` flag is off (enabled.ts). The session creator's
// phones, or the phones of the named recipients, get one Expo push when a turn
// completes or fails, or the agent asks a question or a permission. Nothing
// else runs: no inbox row, no Web Push, no email, no per-person preferences.
// Callers fire and forget: `notifySessionPushLegacy` never throws.
import { projectSessions, sessionPresenceLeases } from '@kortix/db';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { and, eq, gt, sql } from 'drizzle-orm';
import { config } from '../config';
import { PROJECT_ACTIONS } from '../iam/actions';
import { listAccessible } from '../iam/authorize';
import { logger as defaultLogger } from '../lib/logger';
import { db } from '../shared/db';
import { pushDeviceTokenStore, type PushDeviceTokenRow, type PushDeviceTokenStore } from './device-tokens';
import { sendExpoPushMessages, type ExpoPushMessage, type ExpoPushResult } from './expo-push';
import { clip } from './inbox-store';
import { buildExpoMessages, buildPushContent } from './push-payload';

export type LegacySessionPushType = 'completion' | 'error' | 'question' | 'permission';

export interface LegacySessionPushEvent {
  type: LegacySessionPushType;
  sessionId: string;
  projectId: string;
  /** First question text, for `question` events. */
  question?: string;
  /** Notify these users instead of the session creator. */
  recipients?: readonly string[];
}

export interface LegacySessionPushTarget {
  createdBy: string | null;
  title: string | null;
  /** The session's account: a recipient must still be a member of it. */
  accountId?: string | null;
  /** The session's project: a recipient must still be allowed into it. */
  projectId?: string | null;
}

export interface LegacySessionPushDeps {
  /** `PUSH_NOTIFICATIONS_ENABLED`. False: nothing is read or sent. */
  enabled: boolean;
  loadSession(sessionId: string, projectId: string): Promise<LegacySessionPushTarget | null>;
  isPresent?(userId: string, sessionId: string): Promise<boolean>;
  /** False for a recipient who no longer has access to the session's project. */
  mayReceive?(userId: string, session: LegacySessionPushTarget): Promise<boolean>;
  store: Pick<PushDeviceTokenStore, 'listByUser' | 'deleteTokens'>;
  send(messages: ExpoPushMessage[], store: Pick<PushDeviceTokenStore, 'deleteTokens'>): Promise<ExpoPushResult>;
  logger?: Pick<Console, 'warn'>;
}

export type LegacySessionPushOutcome =
  | { sent: 0; reason: 'disabled' | 'no_session' | 'no_recipient' | 'no_access' | 'no_devices' | 'present' | 'failed' }
  | { sent: number; reason: 'sent'; result: ExpoPushResult };

const KIND: Record<LegacySessionPushType, NotificationKindName> = {
  completion: 'turn_done',
  error: 'turn_error',
  question: 'question',
  permission: 'permission',
};

/** The question line on a phone and in the inbox, whitespace collapsed. */
export const QUESTION_TEXT_MAX_CHARS = 140;

/**
 * The Expo messages for one recipient's devices. Title, body, sound, channel,
 * device switches and priority are push-payload.ts's for the 4 session kinds.
 * `data` keeps the 3 keys an installed app routed on before KRTX-1742.
 */
export function legacySessionPushMessages(
  event: LegacySessionPushEvent,
  title: string | null,
  rows: readonly PushDeviceTokenRow[],
): ExpoPushMessage[] {
  const content = buildPushContent({
    notificationId: '',
    kind: KIND[event.type],
    title: title ?? '',
    body: event.type === 'question' ? clip(event.question ?? '', QUESTION_TEXT_MAX_CHARS) : '',
    projectId: event.projectId,
    sessionId: event.sessionId,
    triggerSlug: null,
  });
  const data = { type: event.type, projectId: event.projectId, sessionId: event.sessionId };
  return buildExpoMessages(content, rows).map((message) => ({ ...message, data }));
}

export function createLegacySessionNotifier(deps: LegacySessionPushDeps) {
  return async function notify(event: LegacySessionPushEvent): Promise<LegacySessionPushOutcome> {
    try {
      if (!deps.enabled) return { sent: 0, reason: 'disabled' };
      const session = await deps.loadSession(event.sessionId, event.projectId);
      if (!session) return { sent: 0, reason: 'no_session' };
      const named = event.recipients ?? (session.createdBy ? [session.createdBy] : []);
      if (named.length === 0) return { sent: 0, reason: 'no_recipient' };
      // A member who left keeps the sessions they created, and teammates keep
      // running them. Their phone must not keep getting the titles and the
      // agent's questions (KRTX-1722).
      const recipients: string[] = [];
      for (const userId of named) {
        if (!deps.mayReceive || (await deps.mayReceive(userId, session))) recipients.push(userId);
      }
      if (recipients.length === 0) return { sent: 0, reason: 'no_access' };
      const messages: ExpoPushMessage[] = [];
      let present = 0;
      for (const userId of recipients) {
        if (await deps.isPresent?.(userId, event.sessionId)) {
          present += 1;
          continue;
        }
        messages.push(...legacySessionPushMessages(event, session.title, await deps.store.listByUser(userId)));
      }
      if (present === recipients.length) return { sent: 0, reason: 'present' };
      if (messages.length === 0) return { sent: 0, reason: 'no_devices' };
      const result = await deps.send(messages, deps.store);
      return { sent: messages.length, reason: 'sent', result };
    } catch (err) {
      (deps.logger ?? defaultLogger).warn('[push] session notification failed', {
        type: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { sent: 0, reason: 'failed' };
    }
  };
}

async function loadSessionTarget(sessionId: string, projectId: string): Promise<LegacySessionPushTarget | null> {
  const [row] = await db
    .select({ createdBy: projectSessions.createdBy, metadata: projectSessions.metadata, accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  // `metadata.name` is the session title (owned by session-title-generate.ts).
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const title = [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string');
  return { createdBy: row.createdBy, title: title ?? null, accountId: row.accountId, projectId };
}

/**
 * May `userId` still be told about this session (KRTX-1722)? The project-list
 * rule (`listAccessible`): account membership plus the project grant, owners
 * and admins on every project, and SSO-only enforcement. It skips the MFA
 * step-up on purpose: a push is not a sign-in. The recipients are the
 * session's creator, who sees their own session wherever they may read the
 * project, and the account's automation owner, an implicit manager.
 */
export async function mayReceiveSessionPush(userId: string, session: LegacySessionPushTarget): Promise<boolean> {
  if (!session.accountId || !session.projectId) return false;
  const accessible = await listAccessible(
    { userId, accountId: session.accountId, credential: { kind: 'jwt' }, ctx: {} },
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
    'project',
  );
  return accessible.mode === 'all' || (accessible.mode === 'allow_only' && accessible.allowed.has(session.projectId));
}

/** Any live presence lease, alerting or not, holds the push back. */
async function anyLiveLease(userId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ tabId: sessionPresenceLeases.tabId })
    .from(sessionPresenceLeases)
    .where(and(
      eq(sessionPresenceLeases.userId, userId),
      eq(sessionPresenceLeases.sessionId, sessionId),
      gt(sessionPresenceLeases.expiresAt, sql`now()`),
    ))
    .limit(1);
  return rows.length > 0;
}

/** The legacy notifier wired to Postgres and Expo. DB suites replace the sender. */
export function liveLegacySessionPushDeps(overrides: Partial<LegacySessionPushDeps> = {}): LegacySessionPushDeps {
  return {
    enabled: config.PUSH_NOTIFICATIONS_ENABLED,
    loadSession: loadSessionTarget,
    mayReceive: mayReceiveSessionPush,
    isPresent: anyLiveLease,
    store: pushDeviceTokenStore(),
    send: (messages, store) =>
      sendExpoPushMessages(messages, { accessToken: config.EXPO_ACCESS_TOKEN || undefined, store }),
    ...overrides,
  };
}

let defaultNotifier: ReturnType<typeof createLegacySessionNotifier> | null = null;

/** Push the session creator's devices (or `event.recipients`'). Never throws. */
export function notifySessionPushLegacy(
  event: LegacySessionPushEvent,
  overrides?: Partial<LegacySessionPushDeps>,
): Promise<LegacySessionPushOutcome> {
  if (overrides) return createLegacySessionNotifier(liveLegacySessionPushDeps(overrides))(event);
  defaultNotifier ??= createLegacySessionNotifier(liveLegacySessionPushDeps());
  return defaultNotifier(event);
}
