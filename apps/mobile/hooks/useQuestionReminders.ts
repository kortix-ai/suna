/**
 * Schedules the local "You need to answer the question." reminder 60 s after
 * a question becomes pending, and cancels it when the question leaves the
 * store (KRTX-2138). The rules are in `lib/notifications/question-reminder.ts`.
 * Mounted once, by `SandboxProvider`, with the session bound to the stream.
 *
 * The OS fires the reminder, so it also fires while the app is suspended. A
 * suspended app sees no answer from another surface: the reminder can then
 * fire for a question already answered. The tap opens the session, which
 * shows it answered.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useRuntimePendingStore } from '@kortix/sdk/react';
import type { BoundSession } from '@/components/session/SessionRuntime';
import { log } from '@/lib/logger';
import {
  createReminderTracker,
  isReminderIdentifier,
  planQuestionReminders,
  questionReminderRequest,
  reminderIdentifier,
} from '@/lib/notifications/question-reminder';
import { getNotifications } from '@/lib/notifications/registration';
import { useNotificationStore } from '@/stores/notification-store';

// Expo Go on Android cannot load expo-notifications (SDK 53+): `getNotifications()` is null there.
const supported = Platform.OS === 'ios' || Platform.OS === 'android';

/** One queue: a cancel never overtakes the schedule of the same reminder. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue(op: () => Promise<unknown>): void {
  queue = queue.then(op).catch((error: unknown) => log.warn('[REMINDER] Notification call failed:', error));
}

/** Cancel and remove every question reminder, also one left by an earlier run of the app. */
function clearAllReminders(): void {
  const Notifications = getNotifications();
  if (!Notifications) return;
  enqueue(async () => {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const request of scheduled) {
      if (isReminderIdentifier(request.identifier)) {
        await Notifications.cancelScheduledNotificationAsync(request.identifier);
      }
    }
    for (const notification of presented) {
      const id = notification.request.identifier;
      if (isReminderIdentifier(id)) await Notifications.dismissNotificationAsync(id);
    }
  });
}

export function useQuestionReminders(session: BoundSession | null, signedIn: boolean): void {
  // Set during render: the SDK binds the new session in a child effect, which
  // runs before this provider's effects, and its hydrate must see this value.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    const Notifications = getNotifications();
    if (!supported || !Notifications) return;
    const tracker = createReminderTracker();

    const run = () => {
      const prefs = useNotificationStore.getState().preferences;
      const plan = planQuestionReminders(tracker, {
        pendingIds: Object.keys(useRuntimePendingStore.getState().questions),
        bound: sessionRef.current,
        enabled: prefs.enabled && prefs.onQuestion,
      });
      for (const requestId of plan.cancel) {
        const identifier = reminderIdentifier(requestId);
        enqueue(async () => {
          await Notifications.cancelScheduledNotificationAsync(identifier);
          // Fired already: take the stale reminder out of the tray.
          await Notifications.dismissNotificationAsync(identifier);
        });
      }
      for (const { requestId, session: target } of plan.schedule) {
        const request = questionReminderRequest({ requestId, session: target, playSound: prefs.playSound });
        enqueue(() =>
          Notifications.scheduleNotificationAsync({
            ...request,
            trigger: { ...request.trigger, type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL },
          })
        );
      }
    };
    runRef.current = run;

    const stopPending = useRuntimePendingStore.subscribe((state, prev) => {
      if (state.questions !== prev.questions) run();
    });
    const stopPrefs = useNotificationStore.subscribe((state, prev) => {
      if (state.preferences !== prev.preferences) run();
    });
    run();
    return () => {
      runRef.current = () => {};
      stopPending();
      stopPrefs();
    };
  }, []);

  // A newly bound session: its hydrated questions schedule.
  const projectId = session?.projectId ?? null;
  const sessionId = session?.sessionId ?? null;
  useEffect(() => {
    runRef.current();
  }, [projectId, sessionId]);

  // Sign-out: no reminder of this account may fire, also one scheduled
  // before the app was last killed. Only on a signed-in → signed-out change:
  // the cold start renders signed out before the session restores.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (wasSignedIn.current && !signedIn && supported) clearAllReminders();
    wasSignedIn.current = signedIn;
  }, [signedIn]);
}
