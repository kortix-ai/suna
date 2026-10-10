import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * KRTX-1742 review: opening a session marked its rows read on the server only,
 * so the bell kept them unread for up to 60 s. The SDK inbox is mocked; the
 * page visibility comes from a fake `document`.
 */

let rows: InboxNotification[] = [];
let inboxOptions: unknown[] = [];
const marked: string[] = [];
let failWrites = false;
/** Ends the pending failed write: the rows come back unread. */
let failNow: () => void = () => {};

mock.module('@kortix/sdk/react', () => ({
  useNotificationInbox: (options: unknown) => {
    inboxOptions.push(options);
    return {
      data: { notifications: rows, unread_count: rows.filter((row) => !row.read).length, next_before: null },
      // Like the SDK: the rows turn read at once, and a failed write restores them.
      markSessionRead: async (sessionId: string) => {
        marked.push(sessionId);
        const previous = rows;
        rows = rows.map((r) => (r.session_id === sessionId ? { ...r, read: true } : r));
        if (failWrites) {
          await new Promise<void>((resolve) => (failNow = resolve));
          rows = previous;
          throw new Error('503');
        }
      },
    };
  },
}));

let visibilityState: 'visible' | 'hidden' = 'visible';
const listeners = new Set<() => void>();
(globalThis as { document?: unknown }).document = {
  get visibilityState() {
    return visibilityState;
  },
  addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
};

const { useOpenSessionRead } = await import('./use-open-session-read');

let next = 0;
function row(overrides: Partial<InboxNotification> = {}): InboxNotification {
  next += 1;
  return {
    id: `0192f0c4-0000-7000-8000-${String(next).padStart(12, '0')}`,
    kind: 'question',
    title: 'Release notes',
    body: '',
    project_id: 'p1',
    project_name: 'Website',
    session_id: 'ses-a',
    trigger_slug: null,
    actor_user_id: null,
    url: '/projects/p1/sessions/ses-a',
    read: false,
    created_at: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

function Probe({ sessionId }: { sessionId: string }) {
  useOpenSessionRead('user-1', sessionId);
  return null;
}

async function mount(sessionId = 'ses-a') {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(Probe, { sessionId }));
  });
  return {
    rerender: () => act(async () => renderer.update(createElement(Probe, { sessionId }))),
    unmount: () => act(async () => renderer.unmount()),
  };
}

beforeEach(() => {
  rows = [];
  inboxOptions = [];
  marked.length = 0;
  failWrites = false;
  visibilityState = 'visible';
  listeners.clear();
});

describe('useOpenSessionRead', () => {
  test('opening a session with unread rows marks it read once, through a disabled inbox observer', async () => {
    rows = [row(), row({ session_id: 'ses-b' })];
    const view = await mount();
    await view.rerender();
    expect(marked).toEqual(['ses-a']);
    expect(inboxOptions[0]).toEqual({ userId: 'user-1', enabled: false });
    await view.unmount();
  });

  test('a session with no unread rows sends nothing', async () => {
    rows = [row({ read: true }), row({ session_id: 'ses-b' })];
    const view = await mount();
    expect(marked).toEqual([]);
    await view.unmount();
  });

  test('a failed write that restores the same row is not sent again; a new unread row is', async () => {
    failWrites = true;
    const first = row();
    rows = [first];
    const view = await mount();
    await view.rerender(); // the optimistic write: no unread row
    await act(async () => failNow());
    await view.rerender(); // the rollback: the same unread row again
    expect(rows[0].read).toBe(false);
    expect(marked).toEqual(['ses-a']);

    rows = [row(), first];
    await view.rerender();
    expect(marked).toEqual(['ses-a', 'ses-a']);
    await act(async () => failNow());
    await view.unmount();
  });

  test('a hidden tab marks nothing until it is shown', async () => {
    visibilityState = 'hidden';
    rows = [row()];
    const view = await mount();
    expect(marked).toEqual([]);

    visibilityState = 'visible';
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(marked).toEqual(['ses-a']);
    await view.unmount();
  });
});
