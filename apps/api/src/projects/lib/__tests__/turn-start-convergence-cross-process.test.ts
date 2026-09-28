/**
 * DEF-DEV-1, enabling cause — the turn-start gate must not answer `current`
 * from another process's stale memo.
 *
 * `desiredMemo` and `runningReleases` are both plain in-process state. Dev runs
 * two API pods behind one load balancer, and `notifyBaseBranchMoved` drops the
 * desired release in the pod that handled the push ONLY. The other pod keeps
 * serving the pre-push release for up to `DESIRED_TTL_MS`, and at
 * turn-start-convergence.ts the gate then returns `current` with zero network
 * calls — forwarding the prompt to a box that is behind, which is the state
 * DEF-DEV-1's R1 shows.
 *
 * These two caches stand in for two pods. One bus stands in for the broadcast.
 * The test is only interesting because the caches are independent: a single
 * shared module singleton would pass it by accident.
 */
import { describe, expect, test } from 'bun:test';
import {
  convergeBeforeTurnStart,
  createDesiredReleaseCache,
  createDesiredReleaseInvalidation,
  type DesiredInvalidationTransport,
  type TurnStartConvergenceDeps,
} from '../turn-start-convergence';

const RELEASE_BEFORE_THE_PUSH = 'a'.repeat(64);
const RELEASE_AFTER_THE_PUSH = 'b'.repeat(64);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

const TARGET = {
  projectId: PROJECT,
  accountId: 'acct-1',
  repoUrl: '/tmp/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  projectMetadata: {},
  baseRef: 'main',
  agentName: 'kortix',
  sessionMetadata: {},
  createdBy: 'user-1',
};

/** Every subscriber on the bus hears every publish. PostgreSQL's LISTEN/NOTIFY
 *  delivers to the publisher too; so does this. */
function fakeBus(): { transport: () => DesiredInvalidationTransport; published: string[] } {
  const handlers: Array<(projectId: string) => void> = [];
  const published: string[] = [];
  return {
    published,
    transport: () => ({
      publish: (projectId) => {
        published.push(projectId);
        for (const handler of handlers) handler(projectId);
      },
      subscribe: (handler) => handlers.push(handler),
    }),
  };
}

/** One API process: its own desired-release cache, its own git resolve. */
function pod(bus: ReturnType<typeof fakeBus>, resolves: () => string) {
  let resolveCalls = 0;
  const cache = createDesiredReleaseCache(
    async () => {
      resolveCalls += 1;
      return resolves();
    },
    // The real memo is bypassed under `bun test`; here it IS the subject.
    { enableInTests: true },
  );
  const invalidate = createDesiredReleaseInvalidation(cache, bus.transport());
  const deps = (): TurnStartConvergenceDeps => ({
    loadTarget: async () => TARGET as never,
    desiredReleaseId: (target, sessionId) => cache.get(target, sessionId),
    // This pod last SAW the box running the pre-push release.
    runningReleaseId: () => RELEASE_BEFORE_THE_PUSH,
    probeRunningRelease: async () => RELEASE_BEFORE_THE_PUSH,
    converge: async () => 'converged',
    releasesEnabled: () => true,
    now: () => Date.now(),
  });
  return { cache, invalidate, deps, resolveCalls: () => resolveCalls };
}

describe('a base move invalidates the desired release in EVERY api process', () => {
  test('the pod that did not handle the push stops answering `current`', async () => {
    const bus = fakeBus();
    let tip = RELEASE_BEFORE_THE_PUSH;
    const podA = pod(bus, () => tip);
    const podB = pod(bus, () => tip);

    // Both pods are warm and both agree with the box. No network, no converge.
    expect((await convergeBeforeTurnStart(SESSION, podA.deps())).decision).toBe('current');
    expect((await convergeBeforeTurnStart(SESSION, podB.deps())).decision).toBe('current');
    expect(podB.resolveCalls()).toBe(1);

    // A push lands on pod A. Pod B never saw the request.
    tip = RELEASE_AFTER_THE_PUSH;
    podA.invalidate(PROJECT);

    // Pod B must now resolve again and find the box behind.
    const onB = await convergeBeforeTurnStart(SESSION, podB.deps());
    expect(podB.resolveCalls()).toBe(2);
    expect(onB.decision).toBe('converged');
  });

  test('without a transport nothing is published, and the local drop still works', async () => {
    let tip = RELEASE_BEFORE_THE_PUSH;
    const cache = createDesiredReleaseCache(async () => tip, { enableInTests: true });
    const invalidate = createDesiredReleaseInvalidation(cache, null);
    const deps: TurnStartConvergenceDeps = {
      loadTarget: async () => TARGET as never,
      desiredReleaseId: (target, sessionId) => cache.get(target, sessionId),
      runningReleaseId: () => RELEASE_BEFORE_THE_PUSH,
      probeRunningRelease: async () => RELEASE_BEFORE_THE_PUSH,
      converge: async () => 'converged',
      releasesEnabled: () => true,
      now: () => Date.now(),
    };
    expect((await convergeBeforeTurnStart(SESSION, deps)).decision).toBe('current');
    tip = RELEASE_AFTER_THE_PUSH;
    expect(() => invalidate(PROJECT)).not.toThrow();
    expect((await convergeBeforeTurnStart(SESSION, deps)).decision).toBe('converged');
  });

  test('a publish that throws never fails the write that moved the branch', () => {
    const cache = createDesiredReleaseCache(async () => RELEASE_BEFORE_THE_PUSH, { enableInTests: true });
    const invalidate = createDesiredReleaseInvalidation(cache, {
      publish: () => {
        throw new Error('the listener connection is down');
      },
      subscribe: () => {},
    });
    expect(() => invalidate(PROJECT)).not.toThrow();
  });
});
