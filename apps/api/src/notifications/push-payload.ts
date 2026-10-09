// What a notification looks like on a phone or in a browser (KRTX-1742).
// One payload shape for Expo `data` and the Web Push JSON body, so a tap
// routes the same way on both.
import { pushTypeOf, type NotificationKindName } from '@kortix/shared/notification-kinds';
import type { PushDeviceTokenRow } from './device-tokens';
import type { ExpoPushMessage } from './expo-push';

export const DEFAULT_PUSH_TITLE = 'Kortix';

export interface NotificationPushPayload {
  notificationId: string;
  kind: NotificationKindName;
  /** The pre-KRTX-1742 name for the 4 session kinds; installed apps route on it. */
  type: string;
  projectId: string | null;
  sessionId: string | null;
  triggerSlug: string | null;
  /** Web path that opens the subject and marks the row read. */
  url: string;
}

export interface NotificationPushContent {
  title: string;
  body: string;
  payload: NotificationPushPayload;
}

const FIXED_BODIES: Partial<Record<NotificationKindName, string>> = {
  turn_done: 'Session complete. Tap to see the result.',
  turn_error: 'The session stopped with an error.',
  permission: 'Kortix needs your approval to continue.',
};

/** The push body for a kind; `detail` is the inbox row body (question text, error, share line). */
export function pushBodyFor(kind: NotificationKindName, detail: string): string {
  const fixed = FIXED_BODIES[kind];
  if (fixed) return fixed;
  if (kind === 'question') return detail ? `Kortix has a question: ${detail}` : 'Kortix has a question.';
  if (kind === 'automation_failed') return detail ? `Failing: ${detail}` : 'This automation is failing.';
  if (kind === 'automation_recovered') return 'This automation works again.';
  return detail || 'Open Kortix to see it.';
}

/**
 * Reminder ids are `reminder.<hex>` (`newReminderId`, projects/lib/session-reminders.ts).
 * Reminders share the trigger table with kortix.yaml triggers, whose slugs have no `.`.
 * The constant lives here because the notifications layer may not import projects/lib.
 */
export const REMINDER_ID_PREFIX = 'reminder.';

/** The web path a notification opens. `notification=` lets the page mark it read. */
export function notificationUrl(input: {
  notificationId: string;
  projectId: string | null;
  sessionId: string | null;
  triggerSlug: string | null;
}): string {
  const query = `?notification=${encodeURIComponent(input.notificationId)}`;
  if (input.projectId && input.sessionId) {
    return `/projects/${encodeURIComponent(input.projectId)}/sessions/${encodeURIComponent(input.sessionId)}${query}`;
  }
  if (input.projectId && input.triggerSlug) {
    // The Triggers page lists kortix.yaml triggers only; reminders are runtime rows.
    const page = input.triggerSlug.startsWith(REMINDER_ID_PREFIX) ? 'reminders' : 'customize/triggers';
    return `/projects/${encodeURIComponent(input.projectId)}/${page}${query}`;
  }
  if (input.projectId) return `/projects/${encodeURIComponent(input.projectId)}${query}`;
  return `/projects${query}`;
}

/** True when a `notificationUrl` result opens a project's Reminders page. */
export function opensRemindersPage(url: string): boolean {
  return /^\/projects\/[^/?]+\/reminders\?/.test(url);
}

export function buildPushContent(input: {
  notificationId: string;
  kind: NotificationKindName;
  title: string;
  body: string;
  projectId: string | null;
  sessionId: string | null;
  triggerSlug: string | null;
}): NotificationPushContent {
  return {
    title: input.title.trim() || DEFAULT_PUSH_TITLE,
    body: pushBodyFor(input.kind, input.body),
    payload: {
      notificationId: input.notificationId,
      kind: input.kind,
      type: pushTypeOf(input.kind),
      projectId: input.projectId,
      sessionId: input.sessionId,
      triggerSlug: input.triggerSlug,
      url: notificationUrl(input),
    },
  };
}

// Android channels are fixed at app install; new kinds reuse the 4 existing ones.
const SOUNDS: Record<NotificationKindName, { sound: string; channelId: string }> = {
  turn_done: { sound: 'kortix_complete.wav', channelId: 'session-complete' },
  automation_recovered: { sound: 'kortix_complete.wav', channelId: 'session-complete' },
  question: { sound: 'kortix_attention.wav', channelId: 'session-attention' },
  permission: { sound: 'kortix_attention.wav', channelId: 'session-attention' },
  shared: { sound: 'kortix_attention.wav', channelId: 'session-attention' },
  turn_error: { sound: 'kortix_error.wav', channelId: 'session-error' },
  automation_failed: { sound: 'kortix_error.wav', channelId: 'session-error' },
};
const SILENT_CHANNEL_ID = 'session-silent';

// Per-device switches from installed apps. Kinds without a device column follow `enabled`.
const DEVICE_SWITCH: Partial<Record<NotificationKindName, keyof PushDeviceTokenRow>> = {
  turn_done: 'onCompletion',
  turn_error: 'onError',
  question: 'onQuestion',
  permission: 'onPermission',
};

/** Expo messages for one recipient's devices that allow this kind. */
export function buildExpoMessages(
  content: NotificationPushContent,
  rows: readonly PushDeviceTokenRow[],
): ExpoPushMessage[] {
  const kind = content.payload.kind;
  const column = DEVICE_SWITCH[kind];
  return rows
    .filter((row) => row.provider === 'expo' && row.enabled && (!column || row[column] === true))
    .map((row) => ({
      to: row.token,
      title: content.title,
      body: content.body,
      data: { ...content.payload },
      ...(row.playSound ? SOUNDS[kind] : { sound: null, channelId: SILENT_CHANNEL_ID }),
      priority: 'high',
    }));
}
