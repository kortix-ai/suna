import { describe, expect, mock, test } from 'bun:test';

// `useQuery` returns its config so the wiring is asserted without a render tree.
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useSessionMessageAuthors } = await import('./use-session-message-authors');
const { qk } = await import('./query-keys');

describe('useSessionMessageAuthors', () => {
  test('keys on the session and the message count, so a new message refetches', () => {
    const query = useSessionMessageAuthors('p1', 's1', 3) as any;
    expect(query.queryKey).toEqual([...qk.project.sessionMessageAuthors('p1', 's1'), 3]);
    expect((useSessionMessageAuthors('p1', 's1', 4) as any).queryKey).not.toEqual(query.queryKey);
  });

  test('disabled until both ids are known', () => {
    expect((useSessionMessageAuthors(null, 's1', 0) as any).enabled).toBe(false);
    expect((useSessionMessageAuthors('p1', undefined, 0) as any).enabled).toBe(false);
    expect((useSessionMessageAuthors('p1', 's1', 0) as any).enabled).toBe(true);
  });
});
