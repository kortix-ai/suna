import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { UiTranslator } from '../../i18n';
import { useWebNotificationStore } from '../stores/web-notification-store';
import {
  isOtherProject,
  isViewingSession,
  markSessionOnScreen,
  notificationChannels,
  notifyQuestion,
  type WebNotificationType,
} from './web-notifications';

const BLOCKING: WebNotificationType[] = ['question', 'permission'];
const SESSION_TURN: WebNotificationType[] = ['question', 'permission', 'completion', 'error'];

const onScreen = (type: WebNotificationType, windowFocused: boolean) =>
  notificationChannels({ type, hasSession: true, sessionOnScreen: true, windowFocused, otherProject: false });
const anotherSession = (type: WebNotificationType, windowFocused: boolean) =>
  notificationChannels({ type, hasSession: true, sessionOnScreen: false, windowFocused, otherProject: false });
const noSession = (type: WebNotificationType, windowFocused: boolean) =>
  notificationChannels({ type, hasSession: false, sessionOnScreen: false, windowFocused, otherProject: false });
const otherProject = (type: WebNotificationType, windowFocused: boolean, sessionOnScreen = false) =>
  notificationChannels({ type, hasSession: true, sessionOnScreen, windowFocused, otherProject: true });

describe('notificationChannels: one policy decides toast, sound, favicon dot and the OS gate', () => {
  test('another project, window focused: favicon dot only, for a completion or an error', () => {
    for (const type of ['completion', 'error'] as const) {
      expect(otherProject(type, true)).toEqual({ toast: false, sound: false, attention: true, os: false });
    }
    for (const type of BLOCKING) {
      expect(otherProject(type, true)).toEqual({ toast: false, sound: false, attention: false, os: false });
    }
  });

  test('another project, window not focused: favicon dot and OS, no toast and no sound', () => {
    for (const type of ['completion', 'error'] as const) {
      expect(otherProject(type, false)).toEqual({ toast: false, sound: false, attention: true, os: true });
    }
    for (const type of BLOCKING) {
      expect(otherProject(type, false)).toEqual({ toast: false, sound: false, attention: false, os: true });
    }
  });

  test('another project wins over a session that looks on screen', () => {
    for (const type of SESSION_TURN) {
      expect(otherProject(type, false, true)).toEqual(otherProject(type, false, false));
      expect(otherProject(type, true, true)).toEqual(otherProject(type, true, false));
    }
  });

  test('session on screen, focused, question or permission: sound only', () => {
    for (const type of BLOCKING) {
      expect(onScreen(type, true)).toEqual({ toast: false, sound: true, attention: false, os: false });
    }
  });

  test('session on screen, focused, completion: nothing', () => {
    expect(onScreen('completion', true)).toEqual({ toast: false, sound: false, attention: false, os: false });
  });

  test('session on screen, focused, error: toast only', () => {
    expect(onScreen('error', true)).toEqual({ toast: true, sound: false, attention: false, os: false });
  });

  test('session on screen, not focused, question or permission: sound and OS, no toast', () => {
    for (const type of BLOCKING) {
      expect(onScreen(type, false)).toEqual({ toast: false, sound: true, attention: false, os: true });
    }
  });

  test('session on screen, not focused, completion: sound, favicon dot and OS, no toast', () => {
    expect(onScreen('completion', false)).toEqual({ toast: false, sound: true, attention: true, os: true });
  });

  test('session on screen, not focused, error: toast, sound and OS', () => {
    expect(onScreen('error', false)).toEqual({ toast: true, sound: true, attention: false, os: true });
  });

  test('another session of this project, any focus: every channel, favicon dot for a completion', () => {
    for (const windowFocused of [true, false]) {
      for (const type of SESSION_TURN) {
        expect(anotherSession(type, windowFocused)).toEqual({
          toast: true,
          sound: true,
          attention: type === 'completion',
          os: true,
        });
      }
    }
  });

  test('no session, focused: toast for an error, sound for a question or permission, OS always', () => {
    expect(noSession('error', true)).toEqual({ toast: true, sound: false, attention: false, os: true });
    expect(noSession('automation_failed', true)).toEqual({ toast: false, sound: false, attention: false, os: true });
    for (const type of BLOCKING) {
      expect(noSession(type, true)).toEqual({ toast: false, sound: true, attention: false, os: true });
    }
  });

  test('no session, not focused: toast, sound and OS, no favicon dot', () => {
    for (const type of ['completion', 'error', 'question', 'automation_failed'] as const) {
      expect(noSession(type, false)).toEqual({ toast: true, sound: true, attention: false, os: true });
    }
  });

  test('another project without a session has no favicon dot: the dot is per session', () => {
    expect(
      notificationChannels({
        type: 'error',
        hasSession: false,
        sessionOnScreen: false,
        windowFocused: false,
        otherProject: true,
      }),
    ).toEqual({ toast: false, sound: false, attention: false, os: true });
  });

  test('a kind outside the session turn on the session on screen is silent only while focused', () => {
    expect(onScreen('shared', true)).toEqual({ toast: false, sound: false, attention: false, os: false });
    expect(onScreen('shared', false)).toEqual({ toast: true, sound: true, attention: false, os: true });
  });
});

describe('isOtherProject: both sides are known and they differ', () => {
  const realWindow = globalThis.window;
  const at = (pathname: string) => {
    globalThis.window = { location: { pathname } } as unknown as typeof globalThis.window;
  };

  afterEach(() => {
    globalThis.window = realWindow;
  });

  test('the project in the URL is not another project', () => {
    at('/projects/p1/sessions/s1');
    expect(isOtherProject('p1')).toBe(false);
  });

  test('a different project is another project', () => {
    at('/projects/p1/sessions/s1');
    expect(isOtherProject('p2')).toBe(true);
  });

  test('a locale prefix does not hide the project in the URL', () => {
    at('/de/projects/p2/sessions/s1');
    expect(isOtherProject('p1')).toBe(true);
    expect(isOtherProject('p2')).toBe(false);
  });

  test('the project list has no project in the URL', () => {
    at('/projects');
    expect(isOtherProject('p1')).toBe(false);
  });

  test('/projects/new is a page, not a project', () => {
    at('/projects/new');
    expect(isOtherProject('p1')).toBe(false);
  });

  test('a page outside any project changes nothing', () => {
    at('/dashboard');
    expect(isOtherProject('p1')).toBe(false);
  });

  test('a payload without a project is not another project', () => {
    at('/projects/p1');
    expect(isOtherProject(null)).toBe(false);
    expect(isOtherProject(undefined)).toBe(false);
  });
});

describe('markSessionOnScreen: a mounted surface whose session id is not in the URL', () => {
  const realWindow = globalThis.window;
  const SHEET_SESSION = 'session-sheet-1';

  beforeEach(() => {
    globalThis.window = {
      location: { pathname: '/projects/p1/artifacts/a1', search: '' },
    } as unknown as typeof globalThis.window;
  });

  afterEach(() => {
    globalThis.window = realWindow;
  });

  test('a registered session is viewed, and is not viewed after cleanup', () => {
    expect(isViewingSession(SHEET_SESSION)).toBe(false);
    const cleanup = markSessionOnScreen(SHEET_SESSION);
    expect(isViewingSession(SHEET_SESSION)).toBe(true);
    cleanup();
    expect(isViewingSession(SHEET_SESSION)).toBe(false);
  });

  test('a session registered twice needs both cleanups', () => {
    const first = markSessionOnScreen(SHEET_SESSION);
    const second = markSessionOnScreen(SHEET_SESSION);
    first();
    expect(isViewingSession(SHEET_SESSION)).toBe(true);
    second();
    expect(isViewingSession(SHEET_SESSION)).toBe(false);
  });

  test('a registration covers only its own session', () => {
    const cleanup = markSessionOnScreen(SHEET_SESSION);
    expect(isViewingSession('session-other')).toBe(false);
    cleanup();
  });
});

describe('notifyQuestion: the body names the session without its creation time', () => {
  const realWindow = globalThis.window;
  const realNotification = globalThis.Notification;
  const realPreferences = useWebNotificationStore.getState().preferences;
  const t = { raw: (key: string) => key } as unknown as UiTranslator;
  const bodies: (string | undefined)[] = [];

  /** The OS channel is the one that exposes the body without a DOM. */
  class FakeNotification {
    static permission = 'granted';
    constructor(_title: string, options?: NotificationOptions) {
      bodies.push(options?.body);
    }
    close() {}
  }

  beforeEach(() => {
    bodies.length = 0;
    useWebNotificationStore.setState({
      preferences: { ...realPreferences, enabled: true, onQuestion: true, playSound: false },
    });
    globalThis.Notification = FakeNotification as unknown as typeof Notification;
    globalThis.window = {
      location: { pathname: '/projects/p1/artifacts/a1', search: '' },
      Notification: FakeNotification,
    } as unknown as typeof globalThis.window;
  });

  afterEach(() => {
    globalThis.window = realWindow;
    globalThis.Notification = realNotification;
    useWebNotificationStore.setState({ preferences: realPreferences });
  });

  test('a default title drops its ISO suffix', () => {
    notifyQuestion('session-label-1', 'Which branch?', 'New session - 2026-10-31T12:00:00.000Z', t);
    expect(bodies).toEqual(['"New session": Which branch?']);
  });
});
