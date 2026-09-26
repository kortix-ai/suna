/**
 * push — pure rules for remote push notifications
 * (components/notifications/PushNotificationsBridge.tsx,
 * lib/notifications/registration.ts).
 *
 * The server sends `data = { type, projectId, sessionId }`, an iOS `sound`,
 * and an Android `channelId` (apps/api/src/notifications/session-push.ts).
 * This file holds the matching client side: the Android channels, the
 * kind → channel/sound map, the payload parser, the tap route, the
 * foreground rule, and the preference wire format.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import type { NotificationPreferences } from '@/stores/notification-store';
import { projectHref, type ProjectHref } from '@/lib/projects/switcher';

/** The event a push reports. Same values as the server's `data.type`. */
export const NOTIFICATION_KINDS = ['completion', 'error', 'question', 'permission'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The `data` object of a Kortix session push. */
export interface PushData {
  type: NotificationKind;
  projectId: string;
  sessionId: string;
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
 * The Android channel and iOS sound for one event kind. With `playSound`
 * false: the silent channel and no iOS sound. Mirrors the server's choice.
 */
export function deliveryForKind(
  kind: NotificationKind,
  playSound: boolean
): { channelId: string; iosSound: string | null } {
  if (!playSound) return { channelId: CHANNEL_SILENT, iosSound: null };
  switch (kind) {
    case 'completion':
      return { channelId: CHANNEL_COMPLETE, iosSound: 'kortix_complete.wav' };
    case 'error':
      return { channelId: CHANNEL_ERROR, iosSound: 'kortix_error.wav' };
    case 'question':
    case 'permission':
      return { channelId: CHANNEL_ATTENTION, iosSound: 'kortix_attention.wav' };
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The session push in a notification's `data`, or null for any other payload. */
export function parsePushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (!(NOTIFICATION_KINDS as readonly unknown[]).includes(data.type)) return null;
  if (!nonEmptyString(data.projectId) || !nonEmptyString(data.sessionId)) return null;
  return {
    type: data.type as NotificationKind,
    projectId: data.projectId,
    sessionId: data.sessionId,
  };
}

/**
 * Where a tap goes: the project route, plus the project session to open in
 * it. The session is not a route param: a session opens through
 * ProjectScreen's open-by-id path (the push store's `pendingOpen`), the same
 * path as the Sessions page.
 */
export function routeForNotification(data: PushData): { href: ProjectHref; sessionId: string } {
  return { href: projectHref(data.projectId), sessionId: data.sessionId };
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
  if (!data || !input.appActive) return true;
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
