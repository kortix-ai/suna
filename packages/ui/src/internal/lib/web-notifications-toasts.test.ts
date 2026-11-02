import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';

/** One `toast.custom` call. */
type Created = {
  render: (id: string | number) => ReactElement<{ items?: { sessionId: string }[]; title?: string }>;
  options: { id: string | number; onDismiss?: () => void; onAutoClose?: () => void };
};

let created: Created[] = [];
/** Every toast of the test, for the close in `afterEach`. */
let everCreated: Created[] = [];
let dismissed: (string | number)[] = [];

mock.module('sonner', () => ({
  Toaster: () => null,
  toast: {
    custom: (render: Created['render'], options: Created['options']) => {
      created.push({ render, options });
      everCreated.push({ render, options });
      return options.id;
    },
    dismiss: (id: string | number) => {
      dismissed.push(id);
    },
  },
}));

const { dismissStaleNotificationToasts, isStaleToast, markSessionOnScreen, showInAppNotification } = await import(
  './web-notifications'
);

const STACK = 'web-notification-session-stack';
const single = (sessionId: string) => `web-notification-session-${sessionId}`;
const realWindow = globalThis.window;

function at(pathname: string) {
  globalThis.window = {
    location: { pathname, search: '' },
    innerWidth: 1200,
  } as unknown as typeof globalThis.window;
}

const turn = (sessionId: string, projectId = 'p1', type: 'completion' | 'error' = 'completion') =>
  showInAppNotification({ type, title: 'Done', body: 'Done', sessionId, projectId, entityLabel: sessionId });

const ask = (sessionId: string | undefined, projectId: string | null = 'p1') =>
  showInAppNotification({
    type: 'question',
    title: 'Question',
    body: 'Which branch?',
    tag: `question:${sessionId ?? projectId}`,
    sessionId,
    projectId,
  });

const lastCreated = () => created[created.length - 1];
const stackItems = () =>
  lastCreated()
    .render('id')
    .props.items?.map((item) => item.sessionId);

beforeEach(() => {
  created = [];
  everCreated = [];
  dismissed = [];
  at('/projects/p1/files');
});

afterEach(() => {
  // Every toast closes, so no test inherits another's tracking.
  for (const { options } of everCreated) options.onDismiss?.();
  globalThis.window = realWindow;
});

describe('isStaleToast: whether a toast on screen still qualifies', () => {
  const view = {
    onScreen: (sessionId: string) => sessionId === 'on-screen',
    otherProject: (projectId: string | null | undefined) => projectId === 'other',
  };

  test('the session on screen is stale', () => {
    expect(isStaleToast({ sessionId: 'on-screen', projectId: 'here' }, view)).toBe(true);
  });

  test('another project is stale', () => {
    expect(isStaleToast({ sessionId: 'elsewhere', projectId: 'other' }, view)).toBe(true);
    expect(isStaleToast({ sessionId: null, projectId: 'other' }, view)).toBe(true);
  });

  test('another session of this project stays', () => {
    expect(isStaleToast({ sessionId: 'elsewhere', projectId: 'here' }, view)).toBe(false);
  });

  test('a toast without a session or a project stays', () => {
    expect(isStaleToast({ sessionId: null, projectId: null }, view)).toBe(false);
  });
});

describe('a new session toast never carries a stale item', () => {
  test('two turns of the project on screen stack', () => {
    turn('ses-a');
    turn('ses-b');
    expect(lastCreated().options.id).toBe(STACK);
    expect(stackItems()).toEqual(['ses-a', 'ses-b']);
    expect(dismissed).toContain(single('ses-a'));
  });

  test("project A's item does not reach a toast on project B", () => {
    turn('ses-a', 'p1');
    at('/projects/p2/files');
    turn('ses-b', 'p2');
    expect(lastCreated().options.id).toBe(single('ses-b'));
    expect(dismissed).toContain(single('ses-a'));
  });

  test("X's item does not reach a toast on X's page", () => {
    turn('ses-x');
    at('/projects/p1/sessions/ses-x');
    turn('ses-y');
    expect(lastCreated().options.id).toBe(single('ses-y'));
    expect(dismissed).toContain(single('ses-x'));
  });

  test('a stack of three keeps the items that qualify', () => {
    turn('ses-x');
    turn('ses-y');
    at('/projects/p1/sessions/ses-x');
    turn('ses-z');
    expect(lastCreated().options.id).toBe(STACK);
    expect(stackItems()).toEqual(['ses-y', 'ses-z']);
  });

  test('no remaining item: the new toast is single and the stack retires', () => {
    turn('ses-x');
    turn('ses-y');
    dismissed = [];
    at('/projects/p2/files');
    turn('ses-z', 'p2');
    expect(lastCreated().options.id).toBe(single('ses-z'));
    expect(dismissed).toContain(STACK);
  });

  test('one stale item of a pair: the new item and the other one stack', () => {
    turn('ses-x');
    at('/projects/p1/sessions/ses-x');
    turn('ses-y');
    expect(lastCreated().options.id).toBe(single('ses-y'));
    turn('ses-z');
    expect(lastCreated().options.id).toBe(STACK);
    expect(stackItems()).toEqual(['ses-y', 'ses-z']);
  });
});

describe('dismissStaleNotificationToasts: a toast leaves when the screen moves', () => {
  test('a question about the session now on screen', () => {
    ask('ses-x');
    at('/projects/p1/sessions/ses-x');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual(['web-notification-question:ses-x']);
  });

  test('a toast of a project no longer on screen', () => {
    ask(undefined, 'p1');
    at('/projects/p2/files');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual(['web-notification-question:p1']);
  });

  test('a single session card of the session now on screen, or of another project', () => {
    turn('ses-x', 'p1', 'error');
    at('/projects/p1/sessions/ses-x');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual([single('ses-x')]);

    dismissed = [];
    turn('ses-y', 'p1');
    at('/projects/p2/files');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual([single('ses-y')]);
  });

  test('a same-project toast about another session stays', () => {
    ask('ses-x');
    turn('ses-y');
    at('/projects/p1/sessions/ses-z');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual([]);
  });

  test('a stack drops the item that no longer qualifies', () => {
    turn('ses-x');
    turn('ses-y');
    turn('ses-z');
    at('/projects/p1/sessions/ses-x');
    created = [];
    dismissStaleNotificationToasts();
    expect(lastCreated().options.id).toBe(STACK);
    expect(stackItems()).toEqual(['ses-y', 'ses-z']);
  });

  test('a stack of one remaining item becomes the single toast', () => {
    turn('ses-x');
    turn('ses-y');
    at('/projects/p1/sessions/ses-x');
    dismissed = [];
    created = [];
    dismissStaleNotificationToasts();
    expect(dismissed).toContain(STACK);
    expect(lastCreated().options.id).toBe(single('ses-y'));
  });

  test('a stack with no item left is dismissed', () => {
    turn('ses-x');
    turn('ses-y');
    at('/projects/p2/files');
    dismissed = [];
    created = [];
    dismissStaleNotificationToasts();
    expect(dismissed).toContain(STACK);
    expect(created).toEqual([]);
  });

  test('a toast that closed is forgotten: nothing is dismissed for it', () => {
    ask('ses-x');
    lastCreated().options.onAutoClose?.();
    at('/projects/p1/sessions/ses-x');
    dismissStaleNotificationToasts();
    expect(dismissed).toEqual([]);
  });

  test('a surface that shows a session outside its route retires its toast at once', () => {
    turn('ses-x');
    ask('ses-y');
    const cleanup = markSessionOnScreen('ses-x');
    expect(dismissed).toEqual([single('ses-x')]);
    cleanup();
  });

  test('a run with nothing stale changes nothing', () => {
    turn('ses-x');
    turn('ses-y');
    dismissed = [];
    created = [];
    dismissStaleNotificationToasts();
    expect([created, dismissed]).toEqual([[], []]);
  });
});
