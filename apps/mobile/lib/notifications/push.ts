/**
 * push — pure rules for remote push notifications
 * (components/notifications/PushNotificationsBridge.tsx,
 * lib/notifications/registration.ts).
 *
 * The server sends `data = { notificationId, kind, type, projectId,
 * sessionId, triggerSlug, url }`, an iOS `sound`, and an Android `channelId`
 * (apps/api/src/notifications/push-payload.ts). `kind` is one of the 7 inbox
 * kinds (KRTX-1742); `type` keeps the pre-inbox name of the 4 session kinds
 * (`completion`, `error`, `question`, `permission`), which a server from
 * before the inbox sends alone, with no `notificationId`. An automation alert
 * has no session: its tap opens the project.
 * This file holds the matching client side: the Android channels, the
 * kind → channel/sound map, the payload parser, the foreground rule, the
 * preference wire format, and this phone's per-kind switches.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import { INBOX_NOTIFICATION_KINDS, type InboxNotificationKind, type NotificationPreferencesPatch } from '@kortix/sdk';
import type { NotificationPreferences } from '@/stores/notification-store';

/** The pre-inbox `type` of the 4 session kinds (`LEGACY_PUSH_TYPE` on the server). */
const LEGACY_PUSH_TYPES: ReadonlyMap<string, InboxNotificationKind> = new Map([
  ['completion', 'turn_done'],
  ['error', 'turn_error'],
  ['question', 'question'],
  ['permission', 'permission'],
]);

/** The `data` object of a Kortix push, as the tap and foreground rules read it. */
export interface PushData {
  kind: InboxNotificationKind;
  projectId: string;
  /** The session to open. Null for an alert about the project (an automation): the tap opens the project. */
  sessionId: string | null;
  /** The inbox row the push reports, marked read on tap. Null from a server before the inbox. */
  notificationId: string | null;
}

/** Android channel ids. A channel's sound cannot change after creation. */
export const CHANNEL_COMPLETE = 'session-complete';
export const CHANNEL_ATTENTION = 'session-attention';
export const CHANNEL_ERROR = 'session-error';
export const CHANNEL_SILENT = 'session-silent';

export interface AndroidChannelSpec {
  id: string;
  /** Shown in the system notification settings. */
  name: string;
  /** Bundled sound file name (expo-notifications plugin `sounds`), or null. */
  sound: string | null;
}

/** The four channels the server targets. All use high importance (heads-up). */
export const ANDROID_CHANNELS: readonly AndroidChannelSpec[] = [
  { id: CHANNEL_COMPLETE, name: 'Session complete', sound: 'kortix_complete.wav' },
  { id: CHANNEL_ATTENTION, name: 'Needs your attention', sound: 'kortix_attention.wav' },
  { id: CHANNEL_ERROR, name: 'Session errors', sound: 'kortix_error.wav' },
  { id: CHANNEL_SILENT, name: 'Silent', sound: null },
];

/**
 * The Android channel and iOS sound for one kind. With `playSound` false: the
 * silent channel and no iOS sound. Mirrors the server's choice
 * (`buildExpoMessages`). The 3 kinds added with the inbox reuse the 4
 * existing channels: a new channel or sound needs a native build, and this
 * ships over the air.
 */
export function deliveryForKind(
  kind: InboxNotificationKind,
  playSound: boolean
): { channelId: string; iosSound: string | null } {
  if (!playSound) return { channelId: CHANNEL_SILENT, iosSound: null };
  switch (kind) {
    case 'turn_done':
    case 'automation_recovered':
      return { channelId: CHANNEL_COMPLETE, iosSound: 'kortix_complete.wav' };
    case 'turn_error':
    case 'automation_failed':
      return { channelId: CHANNEL_ERROR, iosSound: 'kortix_error.wav' };
    case 'question':
    case 'permission':
    case 'shared':
      return { channelId: CHANNEL_ATTENTION, iosSound: 'kortix_attention.wav' };
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInboxKind(value: unknown): value is InboxNotificationKind {
  return (INBOX_NOTIFICATION_KINDS as readonly unknown[]).includes(value);
}

/** `kind`, else `type` (a new kind's `type` is its kind), else the legacy `type`. */
function kindOf(data: Record<string, unknown>): InboxNotificationKind | null {
  if (isInboxKind(data.kind)) return data.kind;
  if (isInboxKind(data.type)) return data.type;
  return typeof data.type === 'string' ? (LEGACY_PUSH_TYPES.get(data.type) ?? null) : null;
}

/**
 * The Kortix push in a notification's `data`, or null for any other payload.
 * A tap opens `sessionId` in `projectId` (ProjectScreen's open-by-id path, the
 * push store's `pendingOpen`), or the project when the push has no session.
 */
export function parsePushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const kind = kindOf(data);
  if (!kind || !nonEmptyString(data.projectId)) return null;
  return {
    kind,
    projectId: data.projectId,
    sessionId: nonEmptyString(data.sessionId) ? data.sessionId : null,
    notificationId: nonEmptyString(data.notificationId) ? data.notificationId : null,
  };
}

/**
 * Foreground rule. The app is active and shows that session: no banner and
 * no sound (the live stream's in-app cue already plays). Otherwise: show it.
 * A payload that is not a session push is shown.
 */
export function shouldPresentInForeground(input: {
  data: unknown;
  appActive: boolean;
  viewingSessionId: string | null;
}): boolean {
  const data = parsePushData(input.data);
  if (!data?.sessionId || !input.appActive) return true;
  return input.viewingSessionId !== data.sessionId;
}

/**
 * How a tap reaches the target project from the current root route.
 * `rootSegment` is the first expo-router segment ('' for the index redirect);
 * `currentProjectId` is the focused project's id, or null when no project
 * route is on top.
 * - signed out, or on a boot/auth screen → `wait` (retried on the next route)
 * - the target project already on top → `none` (it opens the session)
 * - another project on top → `replace-project` (root-stack replace: expo-router
 *   cannot diverge `projects/[id]` → `projects/[id]`)
 * - any other screen on top → `replace` with the project route
 */
export function notificationOpenMove(input: {
  signedIn: boolean;
  rootSegment: string;
  currentProjectId: string | null;
  targetProjectId: string;
}): 'wait' | 'none' | 'replace-project' | 'replace' {
  if (!input.signedIn) return 'wait';
  if (WAIT_SEGMENTS.has(input.rootSegment)) return 'wait';
  if (input.currentProjectId === input.targetProjectId) return 'none';
  if (input.currentProjectId) return 'replace-project';
  return 'replace';
}

/** Boot, sign-in, and first-run screens: a tap waits until the app leaves them. */
const WAIT_SEGMENTS: ReadonlySet<string> = new Set(['', 'index', 'auth', 'welcome', 'new']);

/** The server's preference fields (snake_case). */
export interface ServerPreferences {
  enabled: boolean;
  on_completion: boolean;
  on_error: boolean;
  on_question: boolean;
  on_permission: boolean;
  play_sound: boolean;
}

/** This phone's switch for each session kind (Settings → Notifications). */
export type DeviceKindKey = 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission';
export const DEVICE_KIND_SWITCH: Partial<Record<InboxNotificationKind, DeviceKindKey>> = {
  turn_done: 'onCompletion',
  turn_error: 'onError',
  question: 'onQuestion',
  permission: 'onPermission',
};

/**
 * The kinds this phone turned off, as a patch for the user's record
 * (`updateNotificationPreferences`). Null when it turned none off. The patch
 * applies to the whole user: every device and Web Push of a project with
 * `notification_center` on.
 */
export function legacyKindPatch(prefs: NotificationPreferences): NotificationPreferencesPatch | null {
  const kinds: NotificationPreferencesPatch['kinds'] = {};
  for (const [kind, key] of Object.entries(DEVICE_KIND_SWITCH) as [InboxNotificationKind, DeviceKindKey][]) {
    if (prefs[key] === false) kinds[kind] = { push: false };
  }
  return Object.keys(kinds).length ? { kinds } : null;
}

/** The local preferences in the wire format of `POST /notifications/device-token`. */
export function serverPreferences(prefs: NotificationPreferences): ServerPreferences {
  return {
    enabled: prefs.enabled,
    on_completion: prefs.onCompletion,
    on_error: prefs.onError,
    on_question: prefs.onQuestion,
    on_permission: prefs.onPermission,
    play_sound: prefs.playSound,
  };
}

/** Debounce for re-posting preferences after a toggle. */
export const PREFERENCE_SYNC_DEBOUNCE_MS = 500;
/** Upper bound on the sign-out unregister call. */
export const SIGN_OUT_UNREGISTER_TIMEOUT_MS = 3_000;
