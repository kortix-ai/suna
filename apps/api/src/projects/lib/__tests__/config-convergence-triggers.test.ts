/**
 * Convergence triggers with injected deps: a fake clock, fake timers, a fake
 * session list, and a converge spy. Spec: "Convergence triggers".
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  BASE_MOVE_WINDOW_MS,
  branchName,
  createConvergenceTriggers,
  MAX_CONCURRENT_TRIGGERED_CONVERGENCES,
  MAX_SESSIONS_PER_BASE_MOVE,
  pushedBaseCandidates,
  type ConvergenceTriggerDeps,
} from '../config-convergence-triggers';
import type { SessionConfigConvergenceOutcome } from '../session-config-convergence';

let now = 0;
let timers: Array<{ fn: () => void; at: number; id: number }> = [];
let nextId = 0;
let converged: Array<{ sessionId: string; context: string }> = [];
let listed: Array<{ projectId: string; branch: string; limit: number }> = [];
/** Sessions per `(project, branch)`, as the DB query would return them: running, active sandbox. */
let running: Record<string, string[]> = {};
let gate: Promise<void> | null = null;

function deps(): ConvergenceTriggerDeps {
  return {
    converge: async (sessionId, context): Promise<SessionConfigConvergenceOutcome> => {
      converged.push({ sessionId, context });
      if (gate) await gate;
      return 'converged';
    },
    listRunningSessionsOnBase: async (projectId, branch, limit) => {
      listed.push({ projectId, branch, limit });
      return (running[`${projectId}:${branch}`] ?? []).slice(0, limit);
    },
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    now: () => now,
  };
}

/** Advance the fake clock and fire due timers. */
async function advance(ms: number) {
  now += ms;
  const due = timers.filter((timer) => timer.at <= now);
  timers = timers.filter((timer) => timer.at > now);
  for (const timer of due) timer.fn();
  await flush();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  now = 1_000_000;
  timers = [];
  converged = [];
  listed = [];
  running = {};
  gate = null;
});

describe('base-move trigger', () => {
  test('fans out to the running sessions on that branch only', async () => {
    running = { 'p1:main': ['s1', 's2'], 'p1:release': ['s3'] };
    const t = createConvergenceTriggers(deps());
    t.baseMoved('p1', 'refs/heads/main', 'cr-merge');
    await flush();
    await t.settled();
    expect(listed).toEqual([{ projectId: 'p1', branch: 'main', limit: MAX_SESSIONS_PER_BASE_MOVE }]);
    expect(converged.map((c) => c.sessionId)).toEqual(['s1', 's2']);
    expect(converged.every((c) => c.context === 'cr-merge')).toBe(true);
  });

  test('never reaches a stopped session: only what the running-session query returns', async () => {
    // The query filters `project_sessions.status = running` and an active
    // sandbox. A stopped session is absent from its result.
    running = { 'p1:main': [] };
    const t = createConvergenceTriggers(deps());
    t.baseMoved('p1', 'main', 'api-write');
    await flush();
    await t.settled();
    expect(converged).toEqual([]);
  });

  test('rate limit: one fan-out per window, plus one trailing fan-out for later moves', async () => {
    running = { 'p1:main': ['s1'] };
    const t = createConvergenceTriggers(deps());
    t.baseMoved('p1', 'main', 'api-write');
    await flush();
    await advance(1_000);
    t.baseMoved('p1', 'main', 'api-write');
    t.baseMoved('p1', 'main', 'api-write');
    t.baseMoved('p1', 'main', 'git-push');
    await flush();
    expect(listed.length).toBe(1);
    await advance(BASE_MOVE_WINDOW_MS - 1_000 - 1);
    expect(listed.length).toBe(1);
    await advance(1);
    await t.settled();
    expect(listed.length).toBe(2);
    // A move after the window runs at once.
    await advance(BASE_MOVE_WINDOW_MS);
    t.baseMoved('p1', 'main', 'api-write');
    await flush();
    expect(listed.length).toBe(3);
  });

  test('different branches and projects are limited separately', async () => {
    const t = createConvergenceTriggers(deps());
    t.baseMoved('p1', 'main', 'x');
    t.baseMoved('p1', 'release', 'x');
    t.baseMoved('p2', 'main', 'x');
    await flush();
    expect(listed.length).toBe(3);
  });

  test('at most MAX_CONCURRENT convergences run at once, and a session is queued once', async () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const sessions = Array.from({ length: 20 }, (_, i) => `s${i}`);
    running = { 'p1:main': sessions, 'p2:main': ['s0'] };
    const t = createConvergenceTriggers(deps());
    t.baseMoved('p1', 'main', 'x');
    await flush();
    expect(converged.length).toBe(MAX_CONCURRENT_TRIGGERED_CONVERGENCES);
    gate = null;
    release();
    await flush();
    await t.settled();
    expect(converged.length).toBe(20);
    expect(new Set(converged.map((c) => c.sessionId)).size).toBe(20);
  });
});

describe('branchName', () => {
  test('strips refs/heads/', () => {
    expect(branchName('refs/heads/main')).toBe('main');
    expect(branchName('main')).toBe('main');
  });
});

describe('pushedBaseCandidates (git-proxy push trigger)', () => {
  const sha = 'a'.repeat(40);
  const zero = '0'.repeat(40);
  test('reports moved and created branches, skips deletions, tags, and session branches', () => {
    expect(
      pushedBaseCandidates([
        { ref: 'refs/heads/main', newSha: sha },
        { ref: 'refs/heads/release', newSha: sha },
        { ref: 'refs/heads/old', newSha: zero },
        { ref: 'refs/tags/v1', newSha: sha },
        { ref: 'refs/heads/3f2b1c4d-1111-4222-8333-944455556666', newSha: sha },
        { ref: 'refs/heads/main', newSha: sha },
      ]),
    ).toEqual(['main', 'release']);
  });
});
