import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts`: `useQuery`/`useMutation`
// return their config so the wiring can be asserted without a render tree.
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

const { useProjectReminders, useSessionReminders } = await import('./use-reminders');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
});

describe('useProjectReminders / useSessionReminders', () => {
  test('the session key nests under the project key, so one invalidation refreshes both', () => {
    const project = useProjectReminders('p1') as any;
    const session = useSessionReminders('p1', 's1') as any;
    expect(project.queryKey).toEqual(qk.project.reminders('p1'));
    expect(session.queryKey).toEqual(qk.project.sessionReminders('p1', 's1'));
    expect(session.queryKey.slice(0, project.queryKey.length)).toEqual(project.queryKey);
  });

  test('disabled until every id is known', () => {
    expect((useProjectReminders(null) as any).enabled).toBe(false);
    expect((useProjectReminders('p1') as any).enabled).toBe(true);
    expect((useSessionReminders('p1', null) as any).enabled).toBe(false);
    expect((useSessionReminders(null, 's1') as any).enabled).toBe(false);
    expect((useSessionReminders('p1', 's1') as any).enabled).toBe(true);
  });

  test('update and remove invalidate the project reminders key from either hook', () => {
    const project = useProjectReminders('p1') as any;
    const session = useSessionReminders('p1', 's1') as any;
    project.update.onSuccess();
    project.remove.onSuccess();
    session.update.onSuccess();
    session.remove.onSuccess();
    const key = [...qk.project.reminders('p1')];
    expect(invalidated).toEqual([key, key, key, key]);
  });

  test('project mutations target the reminder session; session mutations their own session', async () => {
    const { configureKortix } = await import('../core/http/config');
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
      calls.push(`${opts.method ?? 'GET'} ${String(url)}`);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const project = useProjectReminders('p1') as any;
    const session = useSessionReminders('p1', 's1') as any;
    await project.update.mutationFn({ sessionId: 's9', reminderId: 'reminder.a', enabled: false });
    await project.remove.mutationFn({ sessionId: 's9', reminderId: 'reminder.a' });
    await session.update.mutationFn({ reminderId: 'reminder.b', enabled: true });
    await session.remove.mutationFn('reminder.b');
    expect(calls).toEqual([
      'PATCH http://test.local/projects/p1/sessions/s9/reminders/reminder.a',
      'DELETE http://test.local/projects/p1/sessions/s9/reminders/reminder.a',
      'PATCH http://test.local/projects/p1/sessions/s1/reminders/reminder.b',
      'DELETE http://test.local/projects/p1/sessions/s1/reminders/reminder.b',
    ]);
  });
});
