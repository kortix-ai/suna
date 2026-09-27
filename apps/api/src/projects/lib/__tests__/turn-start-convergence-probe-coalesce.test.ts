/**
 * R4 (docs/specs/turn-latency.md §3) — "a health probe made once by the
 * config gate then again by the catalog gate" is named explicitly as the
 * shape R4 forbids. Parallelising `convergeBeforeTurnStart` and
 * `convergeModelCatalogForTurnStart` (R2) makes that race REAL: both gates
 * call the module-private `probeRunningRelease`, and with no coalescing two
 * concurrent callers for the same session would each issue their own
 * `GET /kortix/health` the instant both memos are cold at once.
 *
 * `probeRunningRelease` must single-flight per session: a second call for the
 * same session while one is already in flight joins the SAME promise instead
 * of dialling the box again.
 *
 * `mock.module` is process-global; this file owns its module graph under
 * `bun test --isolate` (see forward.test.ts for the same convention).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let readCalls = 0;
let readDelayMs = 20;

mock.module('../session-reload', () => ({
  readSandboxConfigState: async (_input: { sessionId: string }) => {
    readCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, readDelayMs));
    return {
      reachable: true,
      configReleases: true,
      release: { release_id: 'a'.repeat(64) },
      runtime: null,
    };
  },
}));
// probeRunningRelease also learns the asset/catalog verdict off the same
// health read (`noteAssetsFromHealth`) — stub the manifest import it pulls in
// so this file never touches the real ~200MB-hashing runtime-assets manifest.
mock.module('../../../runtime-assets/manifest', () => ({
  manifestFingerprint: async () => 'fp',
  runningAssetsVerdict: async () => 'unknown',
}));

const { probeRunningRelease, __resetTurnStartConvergenceForTests } = await import(
  '../turn-start-convergence'
);
const { lastKnownRunningRelease } = await import('../../../config-releases/running-release');

beforeEach(() => {
  readCalls = 0;
  readDelayMs = 20;
  __resetTurnStartConvergenceForTests();
});

describe('probeRunningRelease — one box call per session, per turn (R4)', () => {
  test('two concurrent probes for the same session share one health read', async () => {
    const sessionId = 'sess-coalesce-1';
    const [a, b] = await Promise.all([
      probeRunningRelease(sessionId),
      probeRunningRelease(sessionId),
    ]);
    expect(readCalls).toBe(1);
    expect(a).toBe('a'.repeat(64));
    expect(b).toBe('a'.repeat(64));
    expect(lastKnownRunningRelease(sessionId)).toBe('a'.repeat(64));
  });

  test('two SEQUENTIAL probes (no overlap) each pay their own read', async () => {
    const sessionId = 'sess-coalesce-2';
    await probeRunningRelease(sessionId);
    await probeRunningRelease(sessionId);
    expect(readCalls).toBe(2);
  });

  test('concurrent probes for DIFFERENT sessions are never coalesced', async () => {
    const [a, b] = await Promise.all([
      probeRunningRelease('sess-coalesce-3'),
      probeRunningRelease('sess-coalesce-4'),
    ]);
    expect(readCalls).toBe(2);
    expect(a).toBe('a'.repeat(64));
    expect(b).toBe('a'.repeat(64));
  });
});
