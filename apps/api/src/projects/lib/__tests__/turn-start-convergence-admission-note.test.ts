/**
 * The session-open admission check reads `GET /kortix/health` on every ready
 * open. `noteSandboxHealthBody` records that read the way `probeRunningRelease`
 * records its own, so the first prompt's catalog gate answers from memory
 * instead of reading the same endpoint a second time.
 *
 * `mock.module` is process-global; this file owns its module graph under
 * `bun test --isolate` (see turn-start-convergence-probe-coalesce.test.ts).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Keep the real ~200MB-hashing runtime-assets manifest out of this file. The
// verdict is `behind`: were the admission read to record it, the asset test
// below would see it.
mock.module('../../../runtime-assets/manifest', () => ({
  manifestFingerprint: async () => 'fp',
  runningAssetsVerdict: async () => 'behind',
}));

const { noteSandboxHealthBody, __resetTurnStartConvergenceForTests } = await import('../turn-start-convergence');
const { convergeModelCatalogBeforeTurnStart } = await import('../model-catalog-turn-start');
const { lastKnownManagedCatalog } = await import('../../../runtime-assets/running-catalog');
const { lastKnownRunningRelease } = await import('../../../config-releases/running-release');
const { lastKnownAssetVerdict } = await import('../../../runtime-assets/running-assets');

const HEALTH = {
  capabilities: ['config.release.v1'],
  config: { release_id: 'a'.repeat(64), source: 'release' },
  runtime: {
    build: 1793704768,
    running: { managed_model_ids: ['deepseek-v4.1-flash', 'glm-5.3-flash'], managed_catalog_fallback_reason: null },
  },
};

beforeEach(() => {
  __resetTurnStartConvergenceForTests();
});

/** The turn-start catalog gate with the real memo and a counting probe. */
async function catalogGate(sessionId: string) {
  let probes = 0;
  const outcome = await convergeModelCatalogBeforeTurnStart(sessionId, 'deepseek-v4.1-flash', {
    isLineupModelId: () => true,
    lastKnown: lastKnownManagedCatalog,
    probe: async () => {
      probes += 1;
      return undefined;
    },
    convergeCatalog: async () => null,
    modelConfirmation: () => undefined,
    noteModelConfirmation: () => {},
  });
  return { decision: outcome.decision, probes };
}

describe('noteSandboxHealthBody — the admission read feeds the turn-start gates', () => {
  test('records the managed catalog and the running release from the body', async () => {
    await noteSandboxHealthBody('sess-note-1', HEALTH);
    expect(lastKnownManagedCatalog('sess-note-1')).toEqual({
      ids: ['deepseek-v4.1-flash', 'glm-5.3-flash'],
      fallbackReason: null,
    });
    expect(lastKnownRunningRelease('sess-note-1')).toBe('a'.repeat(64));
  });

  test('records no runtime-asset verdict: a known "behind" would refresh the box mid first turn', async () => {
    await noteSandboxHealthBody('sess-note-6', HEALTH);
    expect(lastKnownAssetVerdict('sess-note-6', 'fp')).toBeUndefined();
  });

  test('the first prompt for a listed model makes no health read of its own', async () => {
    await noteSandboxHealthBody('sess-note-2', HEALTH);
    expect(await catalogGate('sess-note-2')).toEqual({ decision: 'current', probes: 0 });
  });

  test('without the note the same prompt pays one health read (the cost this removes)', async () => {
    expect((await catalogGate('sess-note-3')).probes).toBe(1);
  });

  test('a body that is not a report records nothing and never throws', async () => {
    await noteSandboxHealthBody('sess-note-4', null);
    await noteSandboxHealthBody('sess-note-4', 'not json');
    await noteSandboxHealthBody('sess-note-4', { capabilities: [], runtime: 'x' });
    expect(lastKnownManagedCatalog('sess-note-4')).toBeUndefined();
    expect(lastKnownRunningRelease('sess-note-4')).toBeUndefined();
  });

  test('a daemon without config releases records the catalog but no release', async () => {
    await noteSandboxHealthBody('sess-note-5', { ...HEALTH, capabilities: [] });
    expect(lastKnownManagedCatalog('sess-note-5')?.ids).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash']);
    expect(lastKnownRunningRelease('sess-note-5')).toBeUndefined();
  });
});
