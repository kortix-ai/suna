/**
 * PushNotificationsBridge — the app-wide remote push glue, mounted once in
 * app/_layout.tsx inside the auth and navigation providers. Renders nothing.
 *
 * - Creates the four Android channels (lib/notifications/push.ts).
 * - Sets the foreground handler: no banner and no sound while the user views
 *   that session (the live stream's in-app cue plays instead).
 * - Registers the token on sign-in when OS permission is already granted.
 *   It never asks: requestPushPermissionOnce() asks after the first send.
 * - Registers again on each resume (at most every 10 min) and when the OS
 *   rotates the token, so the server row never goes stale.
 * - Re-posts this phone's Notifications switches 500 ms after a change.
 * - Opens the tapped session, or its project for an automation alert, also
 *   for the tap that cold-started the app. The tap marks its inbox row read
 *   (KRTX-1742), fire and forget.
 * - A push that arrives while the app is open refetches the inbox: the
 *   drawer's count, and ProjectScreen reads the row of the session on screen.
 */

import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useGlobalSearchParams, useNavigationContainerRef, useRouter, useSegments } from 'expo-router';
import { StackActions } from 'expo-router/react-navigation';
import type { NotificationResponse } from 'expo-notifications';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { markNotificationsRead } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import {
  ANDROID_CHANNELS,
  notificationOpenMove,
  parsePushData,
  PREFERENCE_SYNC_DEBOUNCE_MS,
  shouldPresentInForeground,
  shouldReRegisterPush,
} from '@/lib/notifications/push';
import {
  getLastPushRegisteredAt,
  getNotifications,
  remotePushSupported,
  syncPushPreferences,
  syncPushRegistration,
} from '@/lib/notifications/registration';
import { projectHref } from '@/lib/projects/switcher';
import { addResumeListener } from '@/lib/utils/app-resume';
import { useNotificationStore } from '@/stores/notification-store';
import { usePushStore } from '@/stores/push-store';

/** After the stream and auth refresh, and after the warm session (400 ms). */
const PUSH_RESUME_DELAY_MS = 600;

/** Tapped notification ids already handled (the listener and the cold-start read can both see one). */
const handledResponses = new Set<string>();

/** Mark inbox rows read, then refetch the inbox. Fire and forget: a failure leaves the rows unread. */
function markRead(ids: string[], queryClient: QueryClient) {
  markNotificationsRead({ ids })
    .then(() => queryClient.invalidateQueries({ queryKey: qk.notifications.scope() }))
    .catch((error: unknown) => log.warn('[PUSH] Mark read failed:', error));
}

function handleResponse(response: NotificationResponse | null, queryClient: QueryClient) {
  const Notifications = getNotifications();
  if (!response || !Notifications) return;
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const id = response.notification.request.identifier;
  if (handledResponses.has(id)) return;
  handledResponses.add(id);
  const data = parsePushData(response.notification.request.content.data);
  if (!data) return;
  if (data.notificationId) markRead([data.notificationId], queryClient);
  usePushStore.getState().requestOpen(data.projectId, data.sessionId);
}


let setupDone = false;

/** Channels and the foreground handler. Once per process. */
function setUpNotifications() {
  if (setupDone) return;
  setupDone = true;
  const Notifications = getNotifications();
  if (!Notifications) return;

  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const show = shouldPresentInForeground({
          data: notification.request.content.data,
          appActive: AppState.currentState === 'active',
          viewingSessionId: usePushStore.getState().viewingSessionId,
        });
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
  } catch (error) {
    log.warn('[PUSH] Foreground handler not set:', error);
  }

  if (Platform.OS === 'android') {
    for (const channel of ANDROID_CHANNELS) {
      Notifications.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        importance: Notifications.AndroidImportance.HIGH,
        sound: channel.sound,
        enableVibrate: channel.sound !== null,
      }).catch((error: unknown) => log.warn('[PUSH] Channel not created:', channel.id, error));
    }
  }
}

export function PushNotificationsBridge() {
  const { isAuthenticated, mfaRequired } = useAuthContext();
  // A session that owes the TOTP code gets no pushes and opens no session.
  const signedIn = isAuthenticated && !mfaRequired;
  const router = useRouter();
  const navigationRef = useNavigationContainerRef();
  const segments = useSegments() as string[];
  const { id: routeProjectId } = useGlobalSearchParams<{ id?: string }>();
  const pendingOpen = usePushStore((s) => s.pendingOpen);
  const queryClient = useQueryClient();

  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  // Channels, handler, and the tap and arrival listeners. The last response
  // covers a tap that launched the app before this listener existed.
  useEffect(() => {
    setUpNotifications();
    const Notifications = getNotifications();
    if (!Notifications) return;
    const subscriptions: { remove: () => void }[] = [];
    try {
      subscriptions.push(
        Notifications.addNotificationResponseReceivedListener((response) => handleResponse(response, queryClient)),
        // A push that arrived while the app is open: refetch the inbox. A row
        // of the session on screen is then read (ProjectScreen).
        Notifications.addNotificationReceivedListener(() => {
          void queryClient.invalidateQueries({ queryKey: qk.notifications.scope() });
        })
      );
      handleResponse(Notifications.getLastNotificationResponse(), queryClient);
      Notifications.clearLastNotificationResponse();
    } catch (error) {
      log.warn('[PUSH] Notification listeners not set:', error);
    }
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [queryClient]);

  // Sign-in: register when permission is already granted. Each resume
  // registers again, throttled; with no token it also catches a permission
  // allowed in Settings. That waits until the resume work that cannot wait
  // has run.
  useEffect(() => {
    if (!signedIn || !remotePushSupported()) return;
    void syncPushRegistration();
    return addResumeListener(() => {
      if (!signedInRef.current) return;
      const due = shouldReRegisterPush({
        token: usePushStore.getState().token,
        lastRegisteredAt: getLastPushRegisteredAt(),
        now: Date.now(),
      });
      if (due) void syncPushRegistration();
    }, PUSH_RESUME_DELAY_MS);
  }, [signedIn]);

  // The OS rotated the push token: register the new one.
  useEffect(() => {
    if (!signedIn || !remotePushSupported()) return;
    const Notifications = getNotifications();
    if (!Notifications) return;
    let subscription: { remove: () => void } | undefined;
    try {
      subscription = Notifications.addPushTokenListener(() => {
        void syncPushRegistration();
      });
    } catch (error) {
      log.warn('[PUSH] Token listener not set:', error);
    }
    return () => subscription?.remove();
  }, [signedIn]);

  // This phone's switches → server, debounced.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useNotificationStore.subscribe((state, prev) => {
      if (state.preferences === prev.preferences) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (signedInRef.current) void syncPushPreferences();
      }, PREFERENCE_SYNC_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // A tapped notification: move to its project; ProjectScreen opens the
  // session, or project home for an alert without one.
  const rootSegment = segments[0] ?? '';
  const currentProjectId =
    rootSegment === 'projects' && segments[1] === '[id]' && typeof routeProjectId === 'string'
      ? routeProjectId
      : null;
  useEffect(() => {
    if (!pendingOpen || pendingOpen.navigated) return;
    const move = notificationOpenMove({
      signedIn,
      rootSegment,
      currentProjectId,
      targetProjectId: pendingOpen.projectId,
    });
    if (move === 'wait') return;
    usePushStore.getState().markOpenNavigated();
    try {
      if (move === 'replace-project') {
        // A root-stack replace: router.replace cannot leave one `projects/[id]`
        // for another (ProjectScreen's replaceProject does the same).
        navigationRef.dispatch(StackActions.replace('projects/[id]', { id: pendingOpen.projectId }));
      } else if (move === 'replace') {
        router.replace(projectHref(pendingOpen.projectId));
      }
    } catch (error) {
      log.warn('[PUSH] Could not open the tapped session:', error);
    }
  }, [pendingOpen, signedIn, rootSegment, currentProjectId, navigationRef, router]);

  return null;
}
