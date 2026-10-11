// The one notification fan-out (KRTX-1742). Callers resolve WHO (recipients
// that already passed an access check) and WHAT (kind, subject, detail); this
// writes one inbox row per recipient and then sends on the channels each
// recipient's preferences allow:
//
//   1. inbox row — always (the record; idempotent per recipient by dedupe key)
//   2. read at once when the recipient has the session open in a tab
//   3. push (Expo + Web Push) unless an open tab raises its own OS alert
//   4. email now for automation kinds; other kinds get `email_due_at` and the
//      notification worker sends a digest
//
// `PUSH_NOTIFICATIONS_ENABLED=false` stops pushes, never rows or email. Never throws.
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { sessionPresenceLeases } from '@kortix/db';
import {
  IMMEDIATE_EMAIL_KINDS,
  NEVER_DIGESTED_KINDS,
  NOTIFICATION_DIGEST_DELAY_MS,
  type NotificationKindName,
  type NotificationKindPreferences,
} from '@kortix/shared/notification-kinds';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { pushDeviceTokenStore, type PushDeviceTokenRow } from './device-tokens';
import { isNotificationEmailAvailable, sendImmediateNotificationEmail, type ImmediateEmailInput } from './email-delivery';
import { sendExpoPushMessages, type ExpoPushMessage } from './expo-push';
import { inboxStore, type InboxStore } from './inbox-store';
import { loadEffectivePreferences } from './preferences';
import { buildExpoMessages, buildPushContent } from './push-payload';
import { sendWebPushToUser, type WebPushDeliveryInput } from './web-push-delivery';

export interface DeliverInput {
  kind: NotificationKindName;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  triggerSlug?: string | null;
  /** Subject: the session title or the trigger name. */
  title: string;
  /** Detail: question text, error, share line. May be empty. */
  body?: string;
  actorUserId?: string | null;
  /** Per-recipient idempotency key: a repeat with the same key writes nothing. */
  dedupeKey?: string | null;
  /** Users who passed the caller's access check. Duplicates are ignored. */
  recipients: readonly string[];
  /** False: inbox only (a channel thread already carried the event). */
  pushAllowed?: boolean;
}

export interface PresenceState {
  /** A tab that will raise its own OS notification for this session. */
  alerting: boolean;
}

export interface NotifierDeps {
  pushEnabled: boolean;
  inbox: Pick<InboxStore, 'insert' | 'markRead' | 'markEmailed'>;
  loadPreferences(userIds: readonly string[]): Promise<Map<string, NotificationKindPreferences>>;
  /** Recipients with a live lease on the session; absent users are not present. */
  presence(sessionId: string, userIds: readonly string[]): Promise<Map<string, PresenceState>>;
  listDevices(userId: string): Promise<readonly PushDeviceTokenRow[]>;
  sendExpo(messages: ExpoPushMessage[]): Promise<unknown>;
  sendWebPush(input: WebPushDeliveryInput): Promise<{ sent: number }>;
  emailAvailable(): boolean;
  sendEmailNow(input: ImmediateEmailInput): Promise<'sent' | 'skipped' | 'failed'>;
  now(): Date;
  logger: Pick<Console, 'warn'>;
}

export interface DeliveryRecord {
  userId: string;
  /** Null when the row already existed (dedupe) or the write failed. */
  notificationId: string | null;
  readOnArrival: boolean;
  expoMessages: number;
  webPushSent: number;
  email: 'sent' | 'skipped' | 'failed' | 'due' | 'none';
}

function wantsDigest(kind: NotificationKindName, prefs: NotificationKindPreferences): boolean {
  return prefs[kind].email && !IMMEDIATE_EMAIL_KINDS.includes(kind) && !NEVER_DIGESTED_KINDS.includes(kind);
}

export async function deliver(input: DeliverInput, deps: NotifierDeps = liveNotifierDeps()): Promise<DeliveryRecord[]> {
  const recipients = [...new Set(input.recipients.filter((id) => typeof id === 'string' && id.length > 0))];
  if (recipients.length === 0) return [];
  const records: DeliveryRecord[] = [];
  try {
    const prefs = await deps.loadPreferences(recipients);
    const presence = input.sessionId ? await deps.presence(input.sessionId, recipients) : new Map<string, PresenceState>();
    const pushAllowed = input.pushAllowed !== false;
    const expoMessages: ExpoPushMessage[] = [];
    const sideEffects: Promise<unknown>[] = [];

    for (const userId of recipients) {
      const userPrefs = prefs.get(userId);
      if (!userPrefs) continue;
      const record: DeliveryRecord = { userId, notificationId: null, readOnArrival: false, expoMessages: 0, webPushSent: 0, email: 'none' };
      records.push(record);

      // No transport, no digest: a row due now would be mailed months later
      // when email is configured, long after it stopped mattering.
      const digest = pushAllowed && deps.emailAvailable() && wantsDigest(input.kind, userPrefs);
      const notificationId = await deps.inbox.insert({
        userId,
        accountId: input.accountId,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        triggerSlug: input.triggerSlug ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body ?? '',
        actorUserId: input.actorUserId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        emailDueAt: digest ? new Date(deps.now().getTime() + NOTIFICATION_DIGEST_DELAY_MS) : null,
      });
      if (!notificationId) continue;
      record.notificationId = notificationId;
      if (digest) record.email = 'due';

      const here = presence.get(userId);
      if (here) {
        await deps.inbox.markRead(userId, [notificationId]);
        record.readOnArrival = true;
      }

      if (!pushAllowed) continue;
      const content = buildPushContent({
        notificationId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? '',
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        triggerSlug: input.triggerSlug ?? null,
      });

      // The kill switch stops pushes only; email has its own availability check.
      if (deps.pushEnabled && userPrefs[input.kind].push && !here?.alerting) {
        const messages = buildExpoMessages(content, await deps.listDevices(userId));
        record.expoMessages = messages.length;
        expoMessages.push(...messages);
        sideEffects.push(
          deps.sendWebPush({ userId, accountId: input.accountId, content }).then((r) => { record.webPushSent = r.sent; }),
        );
      }

      if (IMMEDIATE_EMAIL_KINDS.includes(input.kind) && userPrefs[input.kind].email && deps.emailAvailable()) {
        sideEffects.push(
          deps.sendEmailNow({
            notificationId,
            userId,
            accountId: input.accountId,
            kind: input.kind,
            title: content.title,
            body: input.body ?? '',
            url: content.payload.url,
          }).then(async (outcome) => {
            record.email = outcome;
            if (outcome !== 'failed') await deps.inbox.markEmailed([notificationId]);
          }),
        );
      }
    }

    if (expoMessages.length > 0) sideEffects.push(deps.sendExpo(expoMessages));
    const settled = await Promise.allSettled(sideEffects);
    for (const result of settled) {
      if (result.status === 'rejected') {
        deps.logger.warn('[notify] channel send failed', {
          kind: input.kind,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  } catch (err) {
    deps.logger.warn('[notify] delivery failed', {
      kind: input.kind,
      sessionId: input.sessionId ?? null,
      triggerSlug: input.triggerSlug ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return records;
}

/** Live leases for these users on this session, and whether any of them alerts. */
export async function loadSessionPresence(sessionId: string, userIds: readonly string[]): Promise<Map<string, PresenceState>> {
  const out = new Map<string, PresenceState>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: sessionPresenceLeases.userId, alerting: sql<boolean>`bool_or(${sessionPresenceLeases.alerts})` })
    .from(sessionPresenceLeases)
    .where(and(
      eq(sessionPresenceLeases.sessionId, sessionId),
      inArray(sessionPresenceLeases.userId, [...userIds]),
      gt(sessionPresenceLeases.expiresAt, sql`now()`),
    ))
    .groupBy(sessionPresenceLeases.userId);
  for (const row of rows) out.set(row.userId, { alerting: row.alerting === true });
  return out;
}

/** The notifier wired to Postgres, Expo, Web Push and email. Tests replace the senders. */
export function liveNotifierDeps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  const devices = pushDeviceTokenStore();
  return {
    pushEnabled: config.PUSH_NOTIFICATIONS_ENABLED,
    inbox: inboxStore(),
    loadPreferences: (userIds) => loadEffectivePreferences(userIds),
    presence: loadSessionPresence,
    listDevices: (userId) => devices.listByUser(userId),
    sendExpo: (messages) =>
      sendExpoPushMessages(messages, { accessToken: config.EXPO_ACCESS_TOKEN || undefined, store: devices, logger }),
    sendWebPush: sendWebPushToUser,
    emailAvailable: isNotificationEmailAvailable,
    sendEmailNow: sendImmediateNotificationEmail,
    now: () => new Date(),
    logger,
    ...overrides,
  };
}
