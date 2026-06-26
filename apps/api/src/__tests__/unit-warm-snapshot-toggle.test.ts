/**
 * Unit tests for the warm-snapshot master toggle (the env→DB admin switch) and
 * the provider-aware warm-fork gate added in the per-project warm-fork change.
 *
 * Covers the REAL logic in runtime-settings.ts + shared/daytona.ts:
 *   1. warmSnapshotSetting() defaults to { enabled: true } — the admin master is
 *      ON by default (an unloaded cache AND a missing DB row both resolve to the
 *      env default ON); a DB row { enabled: false } turns it OFF.
 *   2. warmSnapshotsEnabledFor(provider) = master AND the per-provider sub-gate:
 *      daytona still requires DAYTONA_WARM_TARGET (+ API key) via
 *      warmSnapshotsEnabled(); platinum requires isPlatinumConfigured(); and it
 *      is OFF for every provider when the master row is { enabled: false }.
 *
 * Pure + deterministic: the DB, config, and Platinum deps are mocked (no real
 * DB/network), and the cache is driven explicitly so reads never race a
 * background refresh.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mutable mock state — read lazily inside each mock so individual tests can flip it.
let dbRows: Array<{ key: string; value: unknown }> = [];
const cfg = {
  DAYTONA_API_KEY: '',
  DAYTONA_WARM_TARGET: '',
  KORTIX_WARM_POOL_ENABLED: false,
  KORTIX_WARM_POOL_SIZE: 0,
  KORTIX_WARM_SNAPSHOT_ENABLED: true,
};
let platinumConfigured = false;

mock.module('../config', () => ({ config: cfg }));
mock.module('../shared/platinum', () => ({ isPlatinumConfigured: () => platinumConfigured }));
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(dbRows) }) }) },
}));
mock.module('@kortix/db', () => ({ platformSettings: { key: 'key', value: 'value' } }));
mock.module('drizzle-orm', () => ({ inArray: () => ({}) }));

const { warmSnapshotSetting, refreshRuntimeSettings, invalidateRuntimeSettings, WARM_SNAPSHOT_KEY } = await import(
  '../platform/services/runtime-settings'
);
const { warmSnapshotsEnabledFor, warmSnapshotsEnabled } = await import('../shared/daytona');

/** Load the cache from a given set of DB rows and AWAIT it, so the 30s-TTL cache
 *  is fresh — subsequent sync reads return it without kicking a background refresh. */
async function loadRows(rows: Array<{ key: string; value: unknown }>): Promise<void> {
  dbRows = rows;
  invalidateRuntimeSettings();
  await refreshRuntimeSettings();
}
const MASTER_OFF = [{ key: WARM_SNAPSHOT_KEY, value: { enabled: false } }];

beforeEach(() => {
  // Clean per-provider sub-gate baseline; each test sets what it needs.
  cfg.DAYTONA_API_KEY = '';
  cfg.DAYTONA_WARM_TARGET = '';
  platinumConfigured = false;
});

describe('warmSnapshotSetting (DB-backed admin master, default ON)', () => {
  test('no warm_snapshot row → enabled:true (ON by default)', async () => {
    await loadRows([]);
    expect(warmSnapshotSetting().enabled).toBe(true);
  });

  test('row { enabled: false } → master OFF', async () => {
    await loadRows(MASTER_OFF);
    expect(warmSnapshotSetting().enabled).toBe(false);
  });

  test('row { enabled: true } → master ON', async () => {
    await loadRows([{ key: WARM_SNAPSHOT_KEY, value: { enabled: true } }]);
    expect(warmSnapshotSetting().enabled).toBe(true);
  });

  test('cold cache (before first DB read) follows KORTIX_WARM_SNAPSHOT_ENABLED, not a hardcoded ON', () => {
    // Regression for the 2026-06-26 opencode wedge: a fresh pod served warm-snapshot
    // ON for the ~30s cold-cache window despite an operator "off", warm-forking a
    // stale seed. The cold default is now the env, so a deployment pinned OFF stays
    // OFF before any DB refresh. (invalidate → cache=null → sync read = envDefaults.)
    dbRows = [];
    cfg.KORTIX_WARM_SNAPSHOT_ENABLED = false;
    invalidateRuntimeSettings();
    expect(warmSnapshotSetting().enabled).toBe(false);
    cfg.KORTIX_WARM_SNAPSHOT_ENABLED = true;
    invalidateRuntimeSettings();
    expect(warmSnapshotSetting().enabled).toBe(true);
  });
});

describe('warmSnapshotsEnabledFor (master AND per-provider sub-gate)', () => {
  test('master OFF → false for every provider, even with sub-gates satisfied', async () => {
    await loadRows(MASTER_OFF);
    cfg.DAYTONA_API_KEY = 'k';
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    platinumConfigured = true;
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
    expect(warmSnapshotsEnabledFor('platinum')).toBe(false);
  });

  test('master ON + daytona: requires DAYTONA_WARM_TARGET (+ API key)', async () => {
    await loadRows([]); // master ON (default)
    cfg.DAYTONA_API_KEY = 'k';
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    expect(warmSnapshotsEnabledFor('daytona')).toBe(true);
    cfg.DAYTONA_WARM_TARGET = ''; // no warm target → daytona sub-gate fails
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    cfg.DAYTONA_API_KEY = ''; // no api key → daytona sub-gate fails
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
  });

  test('master ON + platinum: requires isPlatinumConfigured()', async () => {
    await loadRows([]); // master ON
    platinumConfigured = true;
    expect(warmSnapshotsEnabledFor('platinum')).toBe(true);
    platinumConfigured = false;
    expect(warmSnapshotsEnabledFor('platinum')).toBe(false);
  });

  test('platinum does NOT depend on the daytona warm target', async () => {
    await loadRows([]); // master ON
    cfg.DAYTONA_API_KEY = '';
    cfg.DAYTONA_WARM_TARGET = ''; // daytona would be OFF…
    platinumConfigured = true; // …but platinum only needs a configured host
    expect(warmSnapshotsEnabledFor('platinum')).toBe(true);
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
  });

  test('unknown provider → false even with master ON', async () => {
    await loadRows([]); // master ON
    expect(warmSnapshotsEnabledFor('local_docker' as never)).toBe(false);
  });

  test('warmSnapshotsEnabled() (daytona helper) tracks master AND warm target', async () => {
    cfg.DAYTONA_API_KEY = 'k';
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    await loadRows([]); // master ON
    expect(warmSnapshotsEnabled()).toBe(true);
    await loadRows(MASTER_OFF); // master OFF gates it off despite the target
    expect(warmSnapshotsEnabled()).toBe(false);
  });
});

// LAST: the unloaded-cache sync fallback. This read kicks a background refresh,
// so it goes last with dbRows=[] (that refresh also resolves to ON) → harmless.
describe('warmSnapshotSetting (unloaded-cache fallback)', () => {
  test('an unloaded cache returns the env default (enabled:true) synchronously', () => {
    dbRows = [];
    invalidateRuntimeSettings();
    expect(warmSnapshotSetting().enabled).toBe(true);
  });
});
