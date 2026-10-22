import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-session.test.ts`: `useQuery` is mocked so the
// hook runs as a plain function.

let participantCalls: unknown[][] = [];

mock.module('../core/rest/projects-client', () => ({
  getSessionParticipants: (...args: unknown[]) => {
    participantCalls.push(args);
    return Promise.resolve(undefined);
  },
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useSessionParticipants } = await import('./use-session-participants');
const { qk } = await import('./query-keys');
const { contract } = await import('./query-contracts');

beforeEach(() => {
  participantCalls = [];
});

describe('useSessionParticipants', () => {
  test('reads qk.project.sessionParticipants on the inventory contract', async () => {
    const config = useSessionParticipants('proj-1', 'sess-1') as any;
    expect(config.queryKey).toEqual(qk.project.sessionParticipants('proj-1', 'sess-1'));
    expect(config.staleTime).toBe(contract('inventory').staleTime);
    await config.queryFn();
    expect(participantCalls).toEqual([['proj-1', 'sess-1']]);
  });

  test('nests under the session key, so a sharing save invalidates it', () => {
    const key = qk.project.sessionParticipants('proj-1', 'sess-1');
    const parent = qk.project.session('proj-1', 'sess-1');
    expect(key.slice(0, parent.length)).toEqual([...parent]);
  });

  test('is disabled until both ids are known, and honours enabled', () => {
    expect((useSessionParticipants(undefined, 'sess-1') as any).enabled).toBe(false);
    expect((useSessionParticipants('proj-1', undefined) as any).enabled).toBe(false);
    expect((useSessionParticipants('proj-1', 'sess-1', { enabled: false }) as any).enabled).toBe(false);
    expect((useSessionParticipants('proj-1', 'sess-1') as any).enabled).toBe(true);
  });
});
