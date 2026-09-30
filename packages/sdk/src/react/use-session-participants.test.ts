import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-session.test.ts`: `useQuery` is mocked so the
// hook runs as a plain function. `useEffect` runs its callback at once, so the
// "ask again for an unknown sender" rule is asserted on the invalidate calls.

let participantCalls: unknown[][] = [];
let cached: unknown;
let invalidated: unknown[] = [];
let effectDeps: unknown[] | undefined;

mock.module('../core/rest/projects-client', () => ({
  getSessionParticipants: (...args: unknown[]) => {
    participantCalls.push(args);
    return Promise.resolve(cached);
  },
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => ({ ...config, data: cached }),
  useQueryClient: () => ({
    invalidateQueries: (filter: { queryKey: unknown }) => {
      invalidated.push(filter.queryKey);
      return Promise.resolve();
    },
  }),
}));

mock.module('react', () => ({
  useEffect: (effect: () => void, deps?: unknown[]) => {
    effectDeps = deps;
    effect();
  },
}));

const { useSessionParticipants } = await import('./use-session-participants');
const { qk } = await import('./query-keys');
const { contract } = await import('./query-contracts');

const shared = { participants: [], total: 2, multi_user: true, senders: { msg_1: 'U2' }, sender_profiles: [] };

beforeEach(() => {
  participantCalls = [];
  invalidated = [];
  cached = undefined;
  effectDeps = undefined;
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

  test('asks again when the newest user message has no recorded sender', () => {
    cached = shared;
    useSessionParticipants('proj-1', 'sess-1', { newestUserMessageId: 'msg_2' });
    expect(invalidated).toEqual([qk.project.sessionParticipants('proj-1', 'sess-1')]);
  });

  test('asks once per message id: the effect depends on the id, not on the fetched data', () => {
    cached = shared;
    useSessionParticipants('proj-1', 'sess-1', { newestUserMessageId: 'msg_2' });
    // A message that never gets a sender (a slash command) must not loop.
    expect(effectDeps).toEqual(['msg_2', true]);
  });

  test('does not ask when the sender is known, in a single-user session, or before the first read', () => {
    cached = shared;
    useSessionParticipants('proj-1', 'sess-1', { newestUserMessageId: 'msg_1' });
    cached = { ...shared, multi_user: false };
    useSessionParticipants('proj-1', 'sess-1', { newestUserMessageId: 'msg_2' });
    cached = undefined;
    useSessionParticipants('proj-1', 'sess-1', { newestUserMessageId: 'msg_2' });
    useSessionParticipants('proj-1', 'sess-1');
    expect(invalidated).toEqual([]);
  });
});
