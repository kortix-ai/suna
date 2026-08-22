import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts`: `useQuery` is mocked to an
// identity function so the hook can be called as a plain function and the
// exact config it builds — queryKey, queryFn, enabled, freshness — can be
// asserted without a React render tree. `getProjectSession` is mocked too, so
// `queryFn` CAN be invoked here: the whole point of this file is that all
// three readers of `qk.project.session(...)` produce the identical fetcher,
// and that is only provable by calling it and inspecting the arguments.

let sessionCalls: unknown[][] = [];
mock.module('../core/rest/projects-client', () => ({
  getProjectSession: (...args: unknown[]) => {
    sessionCalls.push(args);
    return Promise.resolve({ session_id: 'sess-1', base_ref: 'main' });
  },
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useProjectSession } = await import('./use-project-session');
const { qk } = await import('./query-keys');
const { contract } = await import('./query-contracts');

beforeEach(() => {
  sessionCalls = [];
});

describe('useProjectSession — one contract and one fetcher for qk.project.session', () => {
  test('reads through qk.project.session', () => {
    const config = useProjectSession('proj-1', 'sess-1') as any;
    expect(config.queryKey).toEqual(qk.project.session('proj-1', 'sess-1'));
  });

  // The drift this hook exists to remove: `use-canonical-opencode-session.ts`
  // set a bare `staleTime: 10_000` on the same entry two `apps/web` panels
  // read on `contract('inventory')`. `staleTime` is per-observer, so the
  // window depended on which surface happened to be mounted.
  test('is on the inventory contract, not a hand-written staleTime', () => {
    const config = useProjectSession('proj-1', 'sess-1') as any;
    expect(config.staleTime).toBe(contract('inventory').staleTime);
    expect(config.gcTime).toBe(contract('inventory').gcTime);
    expect(config.refetchOnMount).toBe(true);
  });

  // TanStack keeps ONE queryFn per cached query — whichever observer mounts
  // first wins. Two fetchers that differ in `showErrors` therefore made
  // error-toast behaviour mount-order dependent. Every reader's failure path
  // is a silent fallback (`?? null` for the pin, `?? 'main'` for the base
  // ref), so the toast is unactionable noise: suppressed for all of them.
  test('always fetches with showErrors: false', async () => {
    const config = useProjectSession('proj-1', 'sess-1') as any;
    await config.queryFn();
    expect(sessionCalls).toEqual([['proj-1', 'sess-1', { showErrors: false }]]);
  });

  test('is disabled until both ids are known', () => {
    expect((useProjectSession(undefined, 'sess-1') as any).enabled).toBe(false);
    expect((useProjectSession('proj-1', undefined) as any).enabled).toBe(false);
    expect((useProjectSession('', '') as any).enabled).toBe(false);
    expect((useProjectSession('proj-1', 'sess-1') as any).enabled).toBe(true);
  });

  // `enabled` is legitimately per-observer — it decides whether THIS surface
  // subscribes, not what the entry holds — so an opt-out is allowed where
  // `staleTime` and `queryFn` are not. The session page skips this read when
  // /start already handed it the pin.
  test('an enabled override can suppress the read without changing the entry', () => {
    const off = useProjectSession('proj-1', 'sess-1', { enabled: false }) as any;
    expect(off.enabled).toBe(false);
    expect(off.queryKey).toEqual(qk.project.session('proj-1', 'sess-1'));
    expect(off.staleTime).toBe(contract('inventory').staleTime);
  });

  test('a different session gets its own entry', () => {
    const a = useProjectSession('proj-1', 'sess-a') as any;
    const b = useProjectSession('proj-1', 'sess-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });
});
