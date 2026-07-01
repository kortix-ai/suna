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
};
let platinumConfigured = false;

mock.module('../config', () => ({ config: cfg }));
mock.module('../shared/platinum', () => ({ isPlatinumConfigured: () => platinumConfigured }));
const dbMock = {
  hasDatabase: true,
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(dbRows) }) }) },
};
mock.module('../shared/db', () => dbMock);
mock.module('../../shared/db', () => dbMock);
mock.module('../shared/effect', () => ({
  sharedConfig: cfg,
  sharedDb: dbMock.db,
  sharedFetch: globalThis.fetch,
  sharedSleep: async () => undefined,
  runSharedTimeout: () => undefined,
  runSharedInterval: () => undefined,
  stopSharedTimer: () => undefined,
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
const MASTER_ON = [{ key: WARM_SNAPSHOT_KEY, value: { enabled: true } }];

beforeEach(() => {
  // Clean per-provider sub-gate baseline; each test sets what it needs.
  cfg.DAYTONA_API_KEY = '';
  cfg.DAYTONA_WARM_TARGET = '';
  platinumConfigured = false;
});

describe('warmSnapshotSetting (admin-panel toggle, OFF by default / opt-in)', () => {
  test('no warm_snapshot row → OFF (opt-in; the admin panel must explicitly enable it)', async () => {
    await loadRows([]);
    expect(warmSnapshotSetting().enabled).toBe(false);
  });

  test('row { enabled: false } → OFF', async () => {
    await loadRows(MASTER_OFF);
    expect(warmSnapshotSetting().enabled).toBe(false);
  });

  test('row { enabled: true } → ON (admin opted in)', async () => {
    await loadRows(MASTER_ON);
    expect(warmSnapshotSetting().enabled).toBe(true);
  });

  test('cold cache (before first DB read) is OFF — never warm-fork before the toggle loads', () => {
    // Regression for the 2026-06-26 opencode wedge: a fresh pod served warm ON for
    // the ~30s cold-cache window despite the admin "off", warm-forking a stale seed.
    // An unloaded cache now resolves OFF even when the row is ON — boot warms the
    // cache before serving, so the row is read before any session is created.
    dbRows = MASTER_ON;
    invalidateRuntimeSettings(); // cache=null → sync read = OFF defaults
    expect(warmSnapshotSetting().enabled).toBe(false);
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

  test('no row (default OFF) → false for every provider even with sub-gates satisfied', async () => {
    await loadRows([]);
    cfg.DAYTONA_API_KEY = 'k';
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    platinumConfigured = true;
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
    expect(warmSnapshotsEnabledFor('platinum')).toBe(false);
  });

  test('master ON + daytona: requires DAYTONA_WARM_TARGET (+ API key)', async () => {
    await loadRows(MASTER_ON);
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
    await loadRows(MASTER_ON);
    platinumConfigured = true;
    expect(warmSnapshotsEnabledFor('platinum')).toBe(true);
    platinumConfigured = false;
    expect(warmSnapshotsEnabledFor('platinum')).toBe(false);
  });

  test('platinum does NOT depend on the daytona warm target', async () => {
    await loadRows(MASTER_ON);
    cfg.DAYTONA_API_KEY = '';
    cfg.DAYTONA_WARM_TARGET = ''; // daytona would be OFF…
    platinumConfigured = true; // …but platinum only needs a configured host
    expect(warmSnapshotsEnabledFor('platinum')).toBe(true);
    expect(warmSnapshotsEnabledFor('daytona')).toBe(false);
  });

  test('unknown provider → false even with master ON', async () => {
    await loadRows(MASTER_ON);
    expect(warmSnapshotsEnabledFor('unknown_provider' as never)).toBe(false);
  });

  test('warmSnapshotsEnabled() (daytona helper) tracks master AND warm target', async () => {
    cfg.DAYTONA_API_KEY = 'k';
    cfg.DAYTONA_WARM_TARGET = 'experimental';
    await loadRows(MASTER_ON);
    expect(warmSnapshotsEnabled()).toBe(true);
    await loadRows(MASTER_OFF); // master OFF gates it off despite the target
    expect(warmSnapshotsEnabled()).toBe(false);
  });
});

// LAST: the unloaded-cache sync fallback. This read kicks a background refresh,
// so it goes last with dbRows=[] → harmless.
describe('warmSnapshotSetting (unloaded-cache fallback)', () => {
  test('an unloaded cache returns OFF synchronously (fail-safe; never warm before the row loads)', () => {
    dbRows = [];
    invalidateRuntimeSettings();
    expect(warmSnapshotSetting().enabled).toBe(false);
  });
});
