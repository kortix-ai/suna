/**
 * Web Notification utility module.
 *
 * Provides a thin wrapper around the browser Notification API that respects
 * the user's preferences stored in the web-notification-store.
 *
 * All notification dispatching flows through `sendWebNotification()` which
 * checks:
 *  1. Browser support for the Notification API
 *  2. Permission is granted
 *  3. Master enable toggle is on
 *  4. The specific notification category is enabled
 *  5. Optionally skips if tab is visible (onlyWhenHidden preference)
 */

import { useWebNotificationStore } from '@/stores/web-notification-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { toast } from '@/lib/toast';
import { logger } from '@/lib/logger';
import { softNavigate } from '@/lib/navigation/router-bridge';
import { normalizeAppPathname } from '@kortix/sdk/instance-routes';
import { playSound } from '@/lib/sounds';
import type { SoundEvent } from '@/stores/sound-store';
import { projectSessionHref } from '@/lib/navigation/session-href';

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
  /** Optional click handler — by default focuses the window and navigates to session */
  onClick?: () => void;
}

// ============================================================================
// Preference key mapping
// ============================================================================

const TYPE_TO_PREF: Record<WebNotificationType, 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission'> = {
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
// Sound
// ============================================================================

/**
 * Play a subtle notification sound.
 *
 * Uses the Web Audio API to generate a short ping tone.
 * Falls back silently if audio is not available.
 */
function playNotificationPing() {
  try {
    if (typeof AudioContext === 'undefined' && typeof (window as any).webkitAudioContext === 'undefined') {
      return;
    }
    const AudioCtx = AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);

    // Clean up
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      ctx.close().catch(() => {});
    };
  } catch {
    // Silently ignore — audio not critical
  }
}

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
 */
function isViewingSession(sessionId: string): boolean {
  // Dashboard: the active tab ID is the session ID for session tabs
  const activeTabId = useTabStore.getState().activeTabId;
  if (activeTabId === sessionId) return true;
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
  // 1. Browser support check
  if (!isNotificationSupported()) return null;

  const { preferences } = useWebNotificationStore.getState();

  // Sound plays independently of browser notification preferences — the sound
  // store has its own pack/event/volume settings to control it.
  // Skip ALL non-blocking sounds when the user is actively on the page —
  // they can see everything happening; sounds are just noise.
  // Only play sounds when the tab is hidden (user tabbed away / switched apps).
  const isBlockingType = payload.type === 'question' || payload.type === 'permission';
  const skipSound = !isBlockingType && !isTabHidden();

  if (!skipSound && (force || preferences.playSound !== false)) {
    playSound(TYPE_TO_SOUND[payload.type]);
  }

  if (!force) {
    // 2. Permission check
    if (Notification.permission !== 'granted') return null;

    // 3. Preferences check
    if (!preferences.enabled) return null;

    // 4. Category check
    const prefKey = TYPE_TO_PREF[payload.type];
    if (!preferences[prefKey]) return null;

    // 5. Active session check — skip notifications for the session the user
    //    is currently looking at (they can already see the question/permission
    //    inline in the chat).
    if (payload.sessionId && !isTabHidden() && isViewingSession(payload.sessionId)) {
      return null;
    }

    // 6. Visibility check — questions and permissions always show since the
    //    agent is blocked waiting for user input
    const isBlocking = payload.type === 'question' || payload.type === 'permission';
    if (!isBlocking && preferences.onlyWhenHidden && !isTabHidden()) return null;
  }

  // 6. Fire in-app toast (always works, regardless of OS notification settings)
  showInAppToast(payload);

  // 7. Fire native OS notification (may be blocked by OS settings)
  let notification: Notification | null = null;
  if (Notification.permission === 'granted') {
    try {
      notification = new Notification(payload.title, {
        body: payload.body,
        icon: '/favicon.png',
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

const TOAST_TYPE_MAP: Record<WebNotificationType, 'info' | 'warning' | 'error' | 'success'> = {
  completion: 'success',
  error: 'error',
  question: 'warning',
  permission: 'warning',
};

/**
 * Show an in-app toast notification via sonner.
 * This always works regardless of OS notification settings.
 */
function showInAppToast(payload: WebNotificationPayload) {
  try {
    const variant = TOAST_TYPE_MAP[payload.type];
    const toastFn = toast[variant] || toast;
    toastFn(payload.title, {
      description: payload.body,
      duration: 8000,
      ...(payload.sessionId
        ? {
            action: {
              label: 'Open',
              onClick: () => {
                navigateToSession(payload.sessionId!, payload.body, {
                  projectId: payload.projectId,
                });
              },
            },
          }
        : {}),
    });
  } catch {
    // Silently ignore — toast not critical
  }
}

// ============================================================================
// Convenience senders for each notification type
// ============================================================================

/**
 * Notify that a session task has completed.
 */
export function notifyTaskComplete(sessionId: string, sessionTitle?: string) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 60)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'completion',
    title: 'Task Complete',
    body: `${label} has finished.`,
    tag: `completion:${sessionId}`,
    sessionId,
    // Captured now, while the raising event proves which project is open.
    projectId: currentProjectId(),
  });
}

/**
 * Notify that a session encountered an error.
 */
export function notifySessionError(
  sessionId: string,
  errorTitle: string,
  sessionTitle?: string,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 50)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'error',
    title: 'Session Error',
    body: `${label}: ${errorTitle}`,
    tag: `error:${sessionId}`,
    sessionId,
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
  sessionTitle?: string,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 40)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'question',
    title: 'Input Needed',
    body: `${label}: ${questionText.slice(0, 100)}`,
    tag: `question:${sessionId}`,
    sessionId,
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
  sessionTitle?: string,
) {
  const label = sessionTitle
    ? `"${sessionTitle.slice(0, 40)}"`
    : `Session ${sessionId.slice(0, 8)}`;

  sendWebNotification({
    type: 'permission',
    title: 'Permission Requested',
    body: `${label} needs permission for: ${toolName}`,
    tag: `permission:${sessionId}`,
    sessionId,
    // Captured now, while the raising event proves which project is open.
    projectId: currentProjectId(),
  });
}
