import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-reminders.test.ts`: `useQuery`/`useMutation` return
// their config so the wiring can be asserted without a render tree.
let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const { useRooms, useRoomConversations, useRoom, useRoomMessages, useRoomThread, useSpaceRoom } = await import('./use-rooms');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
});

describe('room hooks', () => {
  test('every key nests under the project rooms key, so one invalidation refreshes them all', () => {
    const root = qk.project.rooms('p1');
    for (const key of [
      (useRooms('p1') as any).queryKey,
      (useRoomConversations('p1') as any).queryKey,
      (useRoom('p1', 'r1') as any).queryKey,
      (useRoomMessages('p1', 'r1') as any).queryKey,
      (useRoomMessages('p1', 'r1', { top: true }) as any).queryKey,
      (useRoomThread('p1', 'r1', 4) as any).queryKey,
    ]) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
  });

  test('disabled until every id is known', () => {
    expect((useRooms(null) as any).enabled).toBe(false);
    expect((useRoomConversations('p1') as any).enabled).toBe(true);
    expect((useRoom('p1', null) as any).enabled).toBe(false);
    expect((useRoomMessages(null, 'r1') as any).enabled).toBe(false);
  });

  test('messages and conversations poll while the page is visible', () => {
    expect((useRoomMessages('p1', 'r1') as any).refetchInterval).toBe(3_000);
    expect((useRoomConversations('p1') as any).refetchInterval).toBe(15_000);
    expect((useRoomMessages('p1', 'r1') as any).refetchIntervalInBackground).toBe(false);
  });

  test('post and markRead refresh the conversation and the unread counts', () => {
    const messages = useRoomMessages('p1', 'r1') as any;
    messages.post.onSuccess();
    messages.markRead.onSuccess();
    expect(invalidated).toEqual([[...qk.project.rooms('p1')], [...qk.project.rooms('p1')]]);
  });

  test('useSpaceRoom reads the room named like the space, and ensure creates it then refreshes every room read', () => {
    const room = useSpaceRoom('p1', 'ops') as any;
    const root = qk.project.rooms('p1');
    expect(room.queryKey.slice(0, root.length)).toEqual([...root]);
    expect(room.queryKey).toContain('ops');
    expect((useSpaceRoom('p1', null) as any).enabled).toBe(false);
    room.ensure.onSuccess();
    expect(invalidated).toEqual([[...root]]);
  });

  test('the timeline and a thread are separate reads; a thread is off until a root is chosen', () => {
    expect((useRoomMessages('p1', 'r1', { top: true }) as any).queryKey).not.toEqual((useRoomMessages('p1', 'r1') as any).queryKey);
    expect((useRoomThread('p1', 'r1', null) as any).enabled).toBe(false);
    expect((useRoomThread('p1', 'r1', 4) as any).enabled).toBe(true);
  });
});
