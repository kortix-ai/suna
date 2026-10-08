import type { UiTranslator } from '@/i18n/translator';
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
 *  4. The specific notification category is enabled
 *  5. Optionally skips if tab is visible (onlyWhenHidden preference)
 */

import { Button } from '@/components/ui/button';
import { dismissToast, errorToast, successToast, warningToast } from '@/components/ui/toast';
import { logger } from '@/lib/logger';
import { softNavigate } from '@/lib/navigation/router-bridge';
import { projectSessionHref } from '@/lib/navigation/session-href';
import { broadcastTurnComplete } from '@/lib/turn-broadcast';
import { playSound } from '@/lib/sounds';
import type { SoundEvent } from '@/stores/sound-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { useTurnAttentionStore } from '@/stores/turn-attention-store';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import { normalizeAppPathname } from '@kortix/sdk';

// ============================================================================
// Types
// ============================================================================

export type WebNotificationType = 'completion' | 'error' | 'question' | 'permission';

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
  /** Localized label for the in-app session action. */
  actionLabel?: string;
  /** Optional click handler — by default focuses the window and navigates to session */
  onClick?: () => void;
}

// ============================================================================
// Preference key mapping
// ============================================================================

const TYPE_TO_PREF: Record<
  WebNotificationType,
  'onCompletion' | 'onError' | 'onQuestion' | 'onPermission'
> = {
  completion: 'onCompletion',
  error: 'onError',
  question: 'onQuestion',
  permission: 'onPermission',
};

/** Map notification types to sound events */
const TYPE_TO_SOUND: Record<WebNotificationType, SoundEvent> = {
  completion: 'completion',
  error: 'error',
  question: 'notification',
  permission: 'notification',
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
  if (!watching) {
    showInAppToast(payload);
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

    // Category check
    const prefKey = TYPE_TO_PREF[payload.type];
    if (!preferences[prefKey]) return null;

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
        if (payload.sessionId) {
          navigateToSession(payload.sessionId, payload.body, {
            forceNavigation: true,
            projectId: payload.projectId,
          });
        }
        payload.onClick?.();
      };

      // Auto-close after 8s (in case the browser doesn't)
      setTimeout(() => {
        try {
          notification?.close();
        } catch {
          // May already be closed
        }
      }, 8000);
    } catch (err) {
      logger.error('Failed to send native notification', { error: String(err) });
    }
  }

  return notification;
}

// ============================================================================
// In-app toast fallback
// ============================================================================

const TOAST_BY_TYPE: Record<WebNotificationType, typeof successToast> = {
  completion: successToast,
  error: errorToast,
  question: warningToast,
  permission: warningToast,
};

/**
 * Show an in-app toast notification.
 * This always works regardless of OS notification settings.
 */
function showInAppToast(payload: WebNotificationPayload) {
  try {
    const id = `web-notification-${payload.tag ?? Date.now()}`;
    const { sessionId, actionLabel } = payload;
    TOAST_BY_TYPE[payload.type](payload.title, {
      id,
      description: payload.body,
      duration: 8000,
      button:
        sessionId && actionLabel
          ? createElement(
              Button,
              {
                size: 'sm',
                variant: 'outline',
                onClick: () => {
                  dismissToast(id);
                  navigateToSession(sessionId, payload.body, { projectId: payload.projectId });
                },
              },
              actionLabel,
            )
          : undefined,
    });
  } catch {
    // Silently ignore — toast not critical
  }
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
) {
  // Captured now, while the raising event proves which project is open — a
  // receiving tab may be on a page whose path holds no project id.
  const projectId = currentProjectId();
  broadcastTurnComplete({ sessionId, sessionTitle, projectId });
  notifyTaskCompleteFor(sessionId, sessionTitle, tI18nComplete, projectId);
}

/**
 * The local completion notification — no cross-tab propagation. This is the
 * shape the broadcast receiver runs so a relayed completion cannot re-broadcast
 * and loop.
 */
export function notifyTaskCompleteFor(
  sessionId: string,
  sessionTitle: string | undefined,
  tI18nComplete: UiTranslator,
  projectId?: string | null,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 60)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'completion',
    title: tI18nComplete.raw('text107f1806b5d7'),
    body: tI18nComplete('text27d628c8b427', { label }),
    tag: `completion:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Verbatim: a relayed null means the publishing tab was not on a project
    // page — reinterpreting it as THIS tab's project would build a wrong
    // deep link (the same rule the click-time path documents above).
    projectId,
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
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 50)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'error',
    title: tI18nComplete.raw('textee584829f9e9'),
    body: `${label}: ${errorTitle}`,
    tag: `error:${sessionId}`,
    sessionId,
    actionLabel: tI18nComplete.raw('texted077f3d8125'),
    // Captured now, while the raising event proves which project is open.
    projectId: currentProjectId(),
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
