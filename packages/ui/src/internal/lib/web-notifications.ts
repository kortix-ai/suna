import type { UiTranslator } from '../../i18n';
import { createElement } from 'react';
/**
 * Web Notification utility module.
 *
 * Provides a thin wrapper around the browser Notification API that respects
 * the user's preferences stored in the web-notification-store.
 *
 * All notification dispatching flows through `sendWebNotification()`. The
 * in-app channels — toast, sound, favicon badge — fire whenever the user is
 * NOT watching the session (another browser tab, another app, or another
 * in-app session), with no permission or preference prerequisite: a default
 * profile must still see that a turn finished. The native OS notification
 * additionally checks:
 *  1. Browser support for the Notification API
 *  2. Permission is granted
 *  3. Master enable toggle is on
 *  4. The kind: for a notification-center payload (an inbox row, or a
 *     session of a project with `notification_center` on), the person's
 *     server-side Push choice; otherwise the per-browser kind switch
 *  5. Optionally skips if tab is visible (onlyWhenHidden preference)
 *
 * Every OS notification carries the tag of the Web Push message for the same
 * event: `<type>:<sessionId>`, or `<type>:<projectId>:<triggerSlug>` for an
 * alert (`notificationTag`). Only two service-worker notifications with one
 * tag replace each other: a `new Notification` never replaces one. So while
 * this browser holds a Web Push subscription, the service worker shows a
 * notification-center payload's copy too, and whichever copy arrives second
 * replaces the first. Any other payload stays a `new Notification`, as before
 * the notification center (KRTX-1742).
 */

import {
  cachedNotificationCenter,
  cachedNotificationCenterAnswer,
} from '../hooks/use-notification-center';
import { hasWebPushSubscription } from '../notifications/web-push';
import {
  customToast,
  dismissToast,
  ToastCard,
  toastIcon,
  errorToast,
  infoToast,
  successToast,
  warningToast,
} from '../../primitives/toast';
import { ClockIcon } from '@phosphor-icons/react';
import {
  SessionFailedCard,
  SessionStackCard,
  type SessionStackItem,
} from '../notifications/session-toast-cards';
import { logger } from './logger';
import { softNavigate } from './navigation/router-bridge';
import { projectSessionHref } from './navigation/session-href';
import {
  broadcastTurnComplete,
  noteTurnCompleteShown,
  turnCompleteShownSince,
  type TurnCompleteMsg,
} from './turn-broadcast';
import { getSharedQueryClient } from './query-client-singleton';
import { playSound } from './sounds';
import type { SoundEvent } from '../stores/sound-store';
import { openTabAndNavigate, useTabStore } from '../stores/tab-store';
import { useTurnAttentionStore } from '../stores/turn-attention-store';
import { useWebNotificationStore } from '../stores/web-notification-store';
import { normalizeAppPathname, type InboxNotificationKind, type NotificationPreferences } from '@kortix/sdk';

// ============================================================================
// Types
// ============================================================================

/** The push `type` of each inbox kind (`pushTypeOf` in `@kortix/shared/notification-kinds`). */
export type WebNotificationType =
  | 'completion'
  | 'error'
  | 'question'
  | 'permission'
  | 'shared'
  | 'automation_failed'
  | 'automation_recovered'
  | 'capture_device_down'
  | 'capture_device_recovered';

export interface WebNotificationPayload {
  /** Which category this notification belongs to */
  type: WebNotificationType;
  /** Notification title */
  title: string;
  /** Notification body text */
  body: string;
  /** Optional tag for deduplication (same tag replaces previous notification) */
  tag?: string;
  /** Session ID to navigate to when clicked */
  sessionId?: string;
  /** Project the session belongs to, captured when the notification is raised.
   *  Without it there is no routable URL — see `navigateToSession`. */
  projectId?: string | null;
  /** Where a click goes when there is no session (an automation alert). */
  href?: string;
  /** Localized label for the in-app open action. */
  actionLabel?: string;
  /**
   * Runs after the default open (focus the window, open the session or
   * `href`) on a click of the OS notification or of the toast's open button.
   * A service-worker notification opens its url and does not run it.
   */
  onClick?: () => void;
  /** The in-app toast's title when it differs from the OS one ("Failure alert in Growth"). */
  inAppTitle?: string;
  /** The subject's display name, for the in-app entity row: a session (no quotes, no timestamp) or an automation. */
  entityLabel?: string;
  /** What went wrong, for the failed-turn card. */
  preview?: string;
  /** Localized "Open session" for the finished-turn toast. */
  openSessionLabel?: string;
  /** Localized "{count} tasks finished" for the stack several turns collapse into. */
  stackTitle?: (count: number) => string;
  /** A row of the notification inbox. Inbox rows exist only for projects with `notification_center` on. */
  fromInbox?: boolean;
  /**
   * The project's `notification_center` flag as the tab that raised the event
   * knew it (a relayed completion). Absent: this tab's query cache decides.
   */
  notificationCenter?: boolean;
}

// ============================================================================
// Server push preference
// ============================================================================

const TYPE_TO_KIND: Record<WebNotificationType, InboxNotificationKind> = {
  completion: 'turn_done',
  error: 'turn_error',
  question: 'question',
  permission: 'permission',
  shared: 'shared',
  automation_failed: 'automation_failed',
  automation_recovered: 'automation_recovered',
  capture_device_down: 'capture_device_down',
  capture_device_recovered: 'capture_device_recovered',
};

/**
 * The person's Push choice per kind, mirrored from the preferences query by
 * `NotificationHost`. Empty until it loads: every kind is allowed then, which
 * is also the server default.
 */
let serverPush: Partial<Record<InboxNotificationKind, boolean>> = {};

export function setServerPushPreferences(kinds: NotificationPreferences['kinds'] | null | undefined) {
  serverPush = {};
  for (const [kind, channels] of Object.entries(kinds ?? {})) {
    serverPush[kind as InboxNotificationKind] = channels.push;
  }
}

function serverPushAllows(type: WebNotificationType): boolean {
  return serverPush[TYPE_TO_KIND[type]] !== false;
}

/**
 * The per-browser switch of each session kind: the kind gate for a payload of
 * a project with `notification_center` off. The other kinds come only from
 * the inbox.
 */
const TYPE_TO_PREF: Partial<
  Record<WebNotificationType, 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission'>
> = {
  completion: 'onCompletion',
  error: 'onError',
  question: 'onQuestion',
  permission: 'onPermission',
};

/**
 * An inbox row, or a session of a project with `notification_center` on: by
 * the raising tab's answer, else by this tab's cached detail or project list.
 * Fail-closed: no project id or nothing cached takes the path from before
 * the notification center.
 */
function fromNotificationCenter(payload: WebNotificationPayload): boolean {
  return (
    payload.fromInbox === true ||
    (payload.notificationCenter ?? cachedNotificationCenter(getSharedQueryClient(), payload.projectId))
  );
}

/** Map notification types to sound events */
const TYPE_TO_SOUND: Record<WebNotificationType, SoundEvent> = {
  completion: 'completion',
  error: 'error',
  question: 'notification',
  permission: 'notification',
  shared: 'notification',
  automation_failed: 'error',
  automation_recovered: 'completion',
  capture_device_down: 'error',
  capture_device_recovered: 'completion',
};

// ============================================================================
// Core
// ============================================================================

/**
 * The project a session belongs to, read from the URL at the moment the
 * notification is RAISED — not when it is clicked.
 *
 * The event that raises a notification comes off that session's own live
 * stream, so the user is on `/projects/<id>/sessions/<sid>` right then. By the
 * time they click, minutes later, they may be anywhere, so reading the path at
 * click time would resolve the wrong project or none at all.
 */
function currentProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Navigate to a session by opening/activating its tab and navigating to it.
 *
 * `projectId` is required for a real URL. `/sessions/<id>` — what this used to
 * build — is not a route at all: it is a leftover of the instance-scoped scheme
 * in `INSTANCE_SCOPED_ROUTES`, so every OS-notification click reloaded the SPA
 * onto a 404. Without a project id there is no honest destination, so the click
 * only focuses the window rather than navigating somewhere wrong.
 */
function navigateToSession(
  sessionId: string,
  sessionTitle?: string,
  opts?: { forceNavigation?: boolean; projectId?: string | null },
) {
  const projectId = opts?.projectId ?? currentProjectId();
  if (!projectId) return;
  const href = projectSessionHref(projectId, sessionId);
  try {
    // Open/activate the tab in the tab store + pushState
    openTabAndNavigate({
      id: sessionId,
      title: sessionTitle || 'Session',
      type: 'session',
      href,
    });
    // A native notification click can arrive while the tab is backgrounded, so
    // the tab store's pushState alone may not bring the session into view.
    // `softNavigate` routes through the App Router; `window.location.assign`
    // here tore down and rebooted the whole SPA on every notification click.
    if (opts?.forceNavigation && window.location.pathname !== href) {
      softNavigate(href);
    }
  } catch {
    softNavigate(href);
  }
}

/**
 * Check if the user is NOT actively looking at the app — either switched
 * to another Chrome tab (`document.hidden`) or switched to another app
 * via Cmd+Tab / Alt+Tab (`!document.hasFocus()`).
 */
export function isTabHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return document.hidden || !document.hasFocus();
}

/**
 * Check if the user is currently viewing a specific session.
 * Checks the tab store (dashboard session tabs) and the current URL
 * (covers the /onboarding page which doesn't use the tab system).
 *
 * Shared with TurnAttentionBadge, which clears the favicon badge for
 * whatever session the user is looking at.
 */
export function isViewingSession(sessionId: string): boolean {
  // Dashboard: the active tab ID is the session ID for session tabs. The
  // persisted tab ID can outlive navigation (the store never clears it when
  // the user clicks elsewhere), so only trust it while the URL still agrees
  // with that tab's href — otherwise a tab parked on a project page would
  // silently suppress every toast for a session it is not showing.
  const { activeTabId, tabs } = useTabStore.getState();
  if (activeTabId === sessionId) {
    const tab = tabs[activeTabId];
    if (typeof window === 'undefined' || !tab?.href) return true;
    if (normalizeAppPathname(window.location.pathname) === normalizeAppPathname(tab.href)) {
      return true;
    }
  }
  // Onboarding page: the user is always viewing the onboarding session.
  // Since the session ID isn't in the URL, we treat any notification as
  // "current session" when the user is on /onboarding.
  if (typeof window !== 'undefined') {
    const path = normalizeAppPathname(window.location.pathname);
    if (path.includes(sessionId)) return true;
    if (path.startsWith('/onboarding')) return true;
  }
  return false;
}

/**
 * Check if the browser supports the Notification API.
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Send a browser web notification, respecting user preferences.
 *
 * Returns the Notification instance if one was created, or null.
 */
export function sendWebNotification(
  payload: WebNotificationPayload,
  /** Skip all preference/permission gates (used for test notifications) */
  force = false,
): Notification | null {
  const { preferences } = useWebNotificationStore.getState();
  const notificationCenter = fromNotificationCenter(payload);

  // The user watching the session live already sees the turn finish in the
  // chat — repeating it as a toast, a sound, a badge or an OS notification
  // would only be noise. `force` (the settings test button) never counts as
  // watching: it exists to prove the channels work.
  const watching =
    !force && !isTabHidden() && (!payload.sessionId || isViewingSession(payload.sessionId));

  // The in-app channels come first and answer to nobody: the toast is the one
  // channel that works on a default profile — permission untouched, browser
  // notifications disabled — which is exactly where the completion signal
  // used to die (the old permission gates returned before the toast ran).
  // A failed turn toasts even to the person watching it: the toast is how an
  // error is noticed. A finished turn does not: the chat already shows it.
  if (!watching || payload.type === 'error') showInAppToast(payload);
  if (!watching) {
    if (payload.type === 'completion' && payload.sessionId) {
      // The toast fades after 8 s; the favicon badge is what a returning
      // user still sees, so a finished turn registers for it here.
      useTurnAttentionStore.getState().markTurnComplete(payload.sessionId);
    }
  }

  // Sound plays independently of browser notification preferences — the sound
  // store has its own pack/event/volume settings to control it. A question or
  // permission request is worth interrupting even while the user watches the
  // session (the agent is blocked); everything else only plays when the
  // session is not being watched.
  const isBlockingType = payload.type === 'question' || payload.type === 'permission';
  const skipSound = !isBlockingType && watching;
  if (!skipSound && (force || preferences.playSound !== false)) {
    playSound(TYPE_TO_SOUND[payload.type]);
  }

  // The OS notification keeps every gate it had: a browser without the
  // Notification API, without granted permission or with notifications
  // disabled still got the toast and the sound above.
  if (!isNotificationSupported()) return null;

  if (!force) {
    // Permission check
    if (Notification.permission !== 'granted') return null;

    // Preferences check
    if (!preferences.enabled) return null;

    // Kind check: the person's Push choice, or this browser's switch.
    if (notificationCenter) {
      if (!serverPushAllows(payload.type)) return null;
    } else {
      const prefKey = TYPE_TO_PREF[payload.type];
      if (prefKey && !preferences[prefKey]) return null;
    }

    // Active session check — skip notifications for the session the user
    // is currently looking at (they can already see the question/permission
    // inline in the chat).
    if (payload.sessionId && !isTabHidden() && isViewingSession(payload.sessionId)) {
      return null;
    }

    // Visibility check — questions and permissions always show since the
    // agent is blocked waiting for user input
    const isBlocking = payload.type === 'question' || payload.type === 'permission';
    if (!isBlocking && preferences.onlyWhenHidden && !isTabHidden()) return null;
  }

  // With Web Push on, the service worker also shows this event's push, and a
  // `new Notification` would never replace it: hand this copy to the worker.
  // `force` (the settings test button) keeps the in-page notification. A
  // project with the flag off gets no push, so its copy stays in the page.
  if (!force && notificationCenter && hasWebPushSubscription() && 'serviceWorker' in navigator) {
    void showWorkerNotification(payload);
    return null;
  }

  // 7. Fire native OS notification (may be blocked by OS settings)
  let notification: Notification | null = null;
  if (Notification.permission === 'granted') {
    try {
      notification = new Notification(payload.title, {
        body: payload.body,
        icon: '/favicon.svg',
        tag: payload.tag,
        // Auto-close after 8 seconds
        requireInteraction: false,
      });

      notification.onclick = () => {
        window.focus();
        notification?.close();
        openPayload(payload, true);
        payload.onClick?.();
      };

      // Auto-close after 8s (in case the browser doesn't)
      setTimeout(() => {
        try {
          notification?.close();
        } catch {
          // May already be closed
        }
      }, NOTIFICATION_VISIBLE_MS);
    } catch (err) {
      logger.error('Failed to send native notification', { error: String(err) });
    }
  }

  return notification;
}

/** A same-tag notification shown this recently is the same event's other copy. */
const SAME_EVENT_MS = 30_000;

/**
 * Whether a notification alerts again when it replaces `existing`, the
 * same-tag notifications on screen: not when one is from the last 30 s (the
 * push for this same event), and yes when it is older (an earlier event).
 * `alertsAgain` in public/sw.js applies the same rule to a push.
 */
function alertsAgain(existing: readonly { data?: unknown }[], now = Date.now()): boolean {
  return (
    existing.length > 0 &&
    existing.every((shown) => {
      const at = (shown.data as { at?: unknown } | null | undefined)?.at;
      return !(typeof at === 'number' && now - at < SAME_EVENT_MS);
    })
  );
}

/** This tab's copy of an OS notification, shown by the service worker. Its click opens `data.url`. */
async function showWorkerNotification(payload: WebNotificationPayload) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = payload.tag ? await registration.getNotifications({ tag: payload.tag }) : [];
    // The same project resolution as `navigateToSession`.
    const projectId = payload.projectId ?? currentProjectId();
    const url = payload.sessionId
      ? projectId
        ? projectSessionHref(projectId, payload.sessionId)
        : '/'
      : (payload.href ?? '/');
    // `renotify` is missing from the DOM typings.
    const options: NotificationOptions & { renotify: boolean } = {
      body: payload.body,
      icon: '/favicon.svg',
      tag: payload.tag,
      renotify: alertsAgain(existing),
      data: { url, at: Date.now() },
    };
    await registration.showNotification(payload.title, options);
  } catch (err) {
    logger.error('Failed to send native notification', { error: String(err) });
  }
}

// ============================================================================
// In-app toast fallback
// ============================================================================

/** How long a notification stays on screen: the toast and the OS notification. */
const NOTIFICATION_VISIBLE_MS = 8000;

const TOAST_BY_VARIANT = {
  success: successToast,
  error: errorToast,
  warning: warningToast,
  info: infoToast,
} as const;

/** Which toast variant each kind uses. */
const NOTIFICATION_TOAST_VARIANT: Record<WebNotificationType, 'success' | 'error' | 'warning' | 'info'> = {
  completion: 'success',
  error: 'error',
  question: 'warning',
  permission: 'warning',
  shared: 'info',
  automation_failed: 'error',
  automation_recovered: 'success',
  capture_device_down: 'error',
  capture_device_recovered: 'success',
};

/** Open what the notification is about: its session, or its `href`. */
function openPayload(payload: WebNotificationPayload, forceNavigation: boolean) {
  if (payload.sessionId) {
    navigateToSession(payload.sessionId, payload.body, {
      forceNavigation,
      projectId: payload.projectId,
    });
  } else if (payload.href) {
    softNavigate(payload.href);
  }
}

/**
 * Show an in-app toast notification.
 * This always works regardless of OS notification settings.
 */
function showInAppToast(payload: WebNotificationPayload) {
  try {
    if (payload.sessionId && (payload.type === 'completion' || payload.type === 'error')) {
      showSessionToast(payload, payload.sessionId);
      return;
    }
    const id = `web-notification-${payload.tag ?? Date.now()}`;
    const { sessionId, href, actionLabel } = payload;
    const automation =
      payload.type === 'automation_failed' || payload.type === 'automation_recovered';
    TOAST_BY_VARIANT[NOTIFICATION_TOAST_VARIANT[payload.type]](payload.inAppTitle ?? payload.title, {
      id,
      // With an entity row the subject is named there; the body is only the detail.
      description: payload.entityLabel ? payload.preview : payload.body,
      entity: payload.entityLabel
        ? {
            icon: automation ? createElement(ClockIcon, { className: 'size-3.5' }) : undefined,
            label: payload.entityLabel,
          }
        : undefined,
      duration: NOTIFICATION_VISIBLE_MS,
      actions:
        (sessionId || href) && actionLabel
          ? [
              {
                label: actionLabel,
                onClick: () => {
                  openPayload(payload, false);
                  payload.onClick?.();
                },
              },
            ]
          : undefined,
    });
  } catch {
    // Silently ignore — toast not critical
  }
}

/** The in-app toast alone — no sound, badge or OS notification (an inbox arrival). */
export const showInAppNotification = (payload: WebNotificationPayload) => showInAppToast(payload);

// ----------------------------------------------------------------------------
// Session turns: one card per turn, a stack when several land together
// ----------------------------------------------------------------------------

type ShownSessionToast = SessionStackItem & { payload: WebNotificationPayload };

/** The finished or failed turns on screen right now, oldest first. */
let shownSessionToasts: ShownSessionToast[] = [];
/** Bumped on every render, so a replaced toast's close cannot clear its successor's list. */
let sessionToastGeneration = 0;

const SESSION_STACK_ID = 'web-notification-session-stack';
const singleSessionToastId = (sessionId: string) => `web-notification-session-${sessionId}`;

/**
 * Show a finished (entity toast) or failed (agent card) turn. While one is on
 * screen, the next turn replaces it with a stack listing both.
 */
function showSessionToast(payload: WebNotificationPayload, sessionId: string) {
  const previous = shownSessionToasts.filter((item) => item.sessionId !== sessionId);
  const item: ShownSessionToast = {
    sessionId,
    label: payload.entityLabel ?? payload.title,
    failed: payload.type === 'error',
    at: Date.now(),
    payload,
  };
  const generation = ++sessionToastGeneration;
  const onClose = () => {
    if (generation === sessionToastGeneration) shownSessionToasts = [];
  };
  shownSessionToasts = [...previous, item];

  const open = (target: ShownSessionToast) => {
    openPayload(target.payload, false);
    target.payload.onClick?.();
  };
  const openLabel = payload.actionLabel ?? 'Open';

  if (previous.length > 0) {
    for (const shown of previous) dismissToast(singleSessionToastId(shown.sessionId));
    const items = shownSessionToasts;
    customToast(
      (dismiss) => (
        createElement(SessionStackCard, {
          title: payload.stackTitle?.(items.length) ?? `${items.length} tasks finished`,
          items,
          openLabel,
          onOpen: (id: string) => {
            const target = items.find((shown) => shown.sessionId === id);
            if (target) open(target);
          },
          onDismiss: dismiss,
        })
      ),
      { id: SESSION_STACK_ID, duration: NOTIFICATION_VISIBLE_MS, onClose },
    );
    return;
  }

  const id = singleSessionToastId(sessionId);
  // A toast for the session on screen (it fired while the window had no
  // focus) names nothing and opens nothing: the person is already there.
  // Read at render, so it follows where the person is now.
  const elsewhere = () => !isViewingSession(sessionId);
  if (item.failed) {
    customToast(
      (dismiss) =>
        createElement(SessionFailedCard, {
          title: payload.inAppTitle ?? payload.title,
          label: elsewhere() ? item.label : undefined,
          detail: payload.preview,
          openLabel,
          onOpen: elsewhere() ? () => open(item) : undefined,
          onDismiss: dismiss,
        }),
      { id, duration: NOTIFICATION_VISIBLE_MS, onClose },
    );
    return;
  }

  customToast(
    (dismiss) =>
      createElement(ToastCard, {
        message: payload.inAppTitle ?? payload.title,
        icon: toastIcon('success'),
        variant: 'success',
        options: elsewhere()
          ? {
              entity: { label: item.label },
              actions: [{ label: payload.openSessionLabel ?? openLabel, onClick: () => open(item) }],
            }
          : undefined,
        onDismiss: dismiss,
      }),
    { id, duration: NOTIFICATION_VISIBLE_MS, onClose },
  );
}

/**
 * The name a notification shows for a session: its title, or `Session <id>`.
 * A default title ends in the ISO time it was made ("New session - 2026-…Z");
 * that suffix is dropped.
 */
export function sessionDisplayName(sessionTitle: string | undefined, sessionId: string): string {
  // One `\s` before `-`, not `\s+`: `.trim()` drops the rest of the run, and
  // `\s+-` backtracks quadratically on a long space run (CodeQL js/polynomial-redos).
  const title = sessionTitle?.replace(/\s-\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '').trim();
  return title ? title.slice(0, 80) : `Session ${sessionId.slice(0, 8)}`;
}

// ============================================================================
// Convenience senders for each notification type
// ============================================================================

/**
 * Notify that a session task has completed — local tabs only.
 *
 * `notifyTaskComplete` is the entry for the live session-event stream, which
 * only session pages mount, so it also publishes the completion to every other
 * Kortix tab (project page, dashboard, a different session) through the
 * cross-tab bridge — they run this same path on receipt. The publishing tab
 * never receives its own broadcast, so nothing doubles locally.
 */
export function notifyTaskComplete(
  sessionId: string,
  sessionTitle: string | undefined,
  tI18nComplete: UiTranslator,
  /** Set when the SDK's turn-end watch found this end: the session page was
   *  not mounted here. `watchedSinceMs` is when the watch started; `projectId`
   *  is the session's project, which the page on screen may not be. */
  handoff?: { watchedSinceMs?: number; projectId?: string },
) {
  // Another tab's stream already announced this end and its relay reached
  // this tab: the watch is the second announcer of the same end.
  const since = handoff?.watchedSinceMs;
  if (since !== undefined && turnCompleteShownSince(sessionId, since)) return;
  // Captured now, while the raising event proves which project is open — a
  // receiving tab may be on a page whose path holds no project id, and may
  // never have loaded the project's `notification_center` flag.
  const projectId = handoff?.projectId ?? currentProjectId();
  const msg = {
    sessionId,
    sessionTitle,
    projectId,
    notificationCenter: cachedNotificationCenterAnswer(getSharedQueryClient(), projectId),
  };
  broadcastTurnComplete(msg);
  notifyTaskCompleteFor(msg, tI18nComplete);
}

/**
 * The local completion notification — no cross-tab propagation. This is the
 * shape the broadcast receiver runs so a relayed completion cannot re-broadcast
 * and loop. It takes the relayed message whole, so no field gets lost.
 */
export function notifyTaskCompleteFor(
  { sessionId, sessionTitle, projectId, notificationCenter }: Omit<TurnCompleteMsg, 'at'>,
  tI18nComplete: UiTranslator,
) {
  noteTurnCompleteShown(sessionId);
  const name = sessionDisplayName(sessionTitle, sessionId);
  const label = sessionTitle ? `"${name.slice(0, 60)}"` : name;

  sendWebNotification({
    type: 'completion',
    entityLabel: name,
    openSessionLabel: tI18nComplete.raw('textb205bb47f81a'),
    stackTitle: (count) => tI18nComplete('textc0589750863c', { count }),
    title: tI18nComplete.raw('text107f1806b5d7'),
    body: tI18nComplete('text27d628c8b427', { label }),
    tag: `completion:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Verbatim: a relayed null means the publishing tab was not on a project
    // page — reinterpreting it as THIS tab's project would build a wrong
    // deep link (the same rule the click-time path documents above).
    projectId,
    notificationCenter,
  });
}

/**
 * Notify that a session encountered an error.
 */
export function notifySessionError(
  sessionId: string,
  errorTitle: string,
  sessionTitle: string | undefined,
  tI18nComplete: UiTranslator,
  /** The session's project, from the SDK's turn-end watch (see `notifyTaskComplete`). */
  projectIdOverride?: string,
) {
  const name = sessionDisplayName(sessionTitle, sessionId);
  const label = sessionTitle ? `"${name.slice(0, 50)}"` : name;

  sendWebNotification({
    type: 'error',
    entityLabel: name,
    preview: errorTitle,
    stackTitle: (count) => tI18nComplete('textc0589750863c', { count }),
    title: tI18nComplete.raw('textee584829f9e9'),
    body: `${label}: ${errorTitle}`,
    tag: `error:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Captured now, while the raising event proves which project is open.
    projectId: projectIdOverride ?? currentProjectId(),
  });
}

/**
 * Notify that Kortix is asking the user a question.
 */
export function notifyQuestion(
  sessionId: string,
  questionText: string,
  sessionTitle: string | undefined,
  tI18nComplete: UiTranslator,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 40)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'question',
    title: tI18nComplete.raw('text6e8c98a8560e'),
    body: `${label}: ${questionText.slice(0, 100)}`,
    tag: `question:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Captured now, while the raising event proves which project is open.
    projectId: currentProjectId(),
  });
}

/**
 * Notify that Kortix needs a permission grant.
 */
export function notifyPermissionRequest(
  sessionId: string,
  toolName: string,
  sessionTitle: string | undefined,
  tI18nComplete: UiTranslator,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 40)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'permission',
    title: tI18nComplete.raw('text7e497182c7ed'),
    body: tI18nComplete('textbe9a4d2a34e1', { label, toolName }),
    tag: `permission:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Captured now, while the raising event proves which project is open.
    projectId: currentProjectId(),
  });
}
