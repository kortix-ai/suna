import { describe, expect, test } from 'bun:test';
import {
  perProjectWarmImageName,
  proj8,
  scopedPerProjectWarmImageName,
} from './ppwarm-names';
import {
  QUOTA_GC_ORG_HIGH_WATER,
  QUOTA_GC_ORG_TARGET,
  SCOPED_PPWARM_PREFIX,
  ppwarmProj8,
  ppwarmTpl8,
  selectSnapshotsToReap,
  type SnapshotLike,
} from './quota-gc-select';

const NOW = Date.parse('2026-07-25T00:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function snap(name: string, opts: Partial<SnapshotLike> = {}): SnapshotLike {
  return {
    id: opts.id ?? `id-${name}`,
    name,
    state: opts.state ?? 'active',
    createdAt: opts.createdAt ?? ago(1),
    lastUsedAt: opts.lastUsedAt ?? ago(1),
  };
}

function padToOrgSize(items: SnapshotLike[], n: number): SnapshotLike[] {
  const pad: SnapshotLike[] = [];
  for (let i = items.length; i < n; i++) pad.push(snap(`daytonaio/sandbox:${i}`));
  return [...items, ...pad];
}

const PROJ = '0945686d-1111-2222-3333-444455556666';
const PROJ_B = '0945686d-aaaa-bbbb-cccc-ddddeeeeffff';
const BASE = 'kortix-default-r1';
const SCOPE_A = '111111111111';
const SCOPE_B = '222222222222';

describe('ppwarmTpl8', () => {
  test('parses the tpl8 segment of a new-format name', () => {
    const name = perProjectWarmImageName(PROJ, 'tip1', BASE, 'custom-tpl');
    const expectedTpl8 = name.split('-')[3];
    expect(ppwarmTpl8(name)).toBe(expectedTpl8);
  });

  test('returns null for an old-format name (no template discriminator)', () => {
    expect(ppwarmTpl8(`kortix-ppwarm-${proj8(PROJ)}-aaaaaaaaaaaa`)).toBeNull();
  });

  test('returns null for a non-ppwarm name', () => {
    expect(ppwarmTpl8('kortix-default-abc123')).toBeNull();
  });

  test('parses scoped project12 and template16 keys', () => {
    const name = scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'custom-tpl');
    const [scope12, project12, template16] = name
      .slice(SCOPED_PPWARM_PREFIX.length)
      .split('-');
    expect(scope12).toBe(SCOPE_A);
    expect(ppwarmProj8(name)).toBe(project12);
    expect(ppwarmTpl8(name)).toBe(template16);
  });

  test.each([
    'kortix-ppwarm-0945686d-nothex',
    'kortix-ppwarm-0945686d-12345678-nothex',
    'kortix-ppwarm-111111111111-123456789abc-1234567890abcdef-fedcba0987654321',
    'kpp2-11111111-123456789abc-1234567890abcdef-fedcba0987654321',
    'kpp2-111111111111-123456789abc-1234567890abcdef-nothex',
    'kpp2-11111111111-123456789abc-1234567890abcdef-fedcba0987654321',
    'kpp2-111111111111-123456789abc-1234567890abcde-fedcba0987654321',
    'kpp2-AAAAAAAAAAAA-123456789abc-1234567890abcdef-fedcba0987654321',
    'kpp2-111111111111-123456789abc-1234567890abcdef-fedcba0987654321-extra',
  ])('rejects malformed ppwarm name %s', (name) => {
    expect(ppwarmProj8(name)).toBeNull();
    expect(ppwarmTpl8(name)).toBeNull();
  });
});

describe('selectSnapshotsToReap — ppwarm superseded-tip rule is template-scoped', () => {
  test('a second template does not supersede — or get superseded by — the default', () => {
    const defaultCur = perProjectWarmImageName(PROJ, 'tip2', BASE, 'default');
    const defaultOld = perProjectWarmImageName(PROJ, 'tip1', BASE, 'default');
    const customCur = perProjectWarmImageName(PROJ, 'tip2', BASE, 'custom-tpl');

    const all = padToOrgSize(
      [
        snap(defaultCur, { lastUsedAt: ago(1) }),
        snap(defaultOld, { lastUsedAt: ago(5) }),
        snap(customCur, { lastUsedAt: ago(5) }),
      ],
      QUOTA_GC_ORG_HIGH_WATER,
    );

    const res = selectSnapshotsToReap({ all, referenced: new Set(), now: NOW });
    const reaped = res.doomed.map((d) => d.snapshot.name);

    expect(reaped).toContain(defaultOld);
    expect(reaped).not.toContain(defaultCur);
    expect(reaped).not.toContain(customCur);
  });

  test('old-format tips of a project still supersede each other exactly as before', () => {
    const newest = `kortix-ppwarm-${proj8(PROJ)}-111111111111`;
    const older = `kortix-ppwarm-${proj8(PROJ)}-222222222222`;
    const all = padToOrgSize(
      [
        snap(newest, { lastUsedAt: ago(1) }),
        snap(older, { lastUsedAt: ago(5) }),
      ],
      QUOTA_GC_ORG_HIGH_WATER,
    );
    const res = selectSnapshotsToReap({ all, referenced: new Set(), now: NOW });
    const reaped = res.doomed.map((d) => d.snapshot.name);
    expect(reaped).toContain(older);
    expect(reaped).not.toContain(newest);
  });
});

describe('selectSnapshotsToReap — scoped ppwarm ownership', () => {
  test('keeps legacy and unscoped images eligible when ownership is provided', () => {
    const legacy = snap(`kortix-ppwarm-${proj8(PROJ)}-111111111111`, {
      state: 'error',
    });
    const unscoped = snap(
      perProjectWarmImageName(PROJ_B, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const all = padToOrgSize([legacy, unscoped], QUOTA_GC_ORG_HIGH_WATER);

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    const reaped = result.doomed.map((candidate) => candidate.snapshot.name);
    expect(reaped).toContain(legacy.name);
    expect(reaped).toContain(unscoped.name);
  });

  test('excludes malformed ppwarm names from broken and idle deletion', () => {
    const malformedBroken = snap('kpp2-111111111111-nothex', {
      state: 'error',
    });
    const malformedIdle = snap('kortix-ppwarm-11111111-22222222-nothex', {
      lastUsedAt: ago(30),
    });
    const all = padToOrgSize(
      [malformedBroken, malformedIdle],
      QUOTA_GC_ORG_HIGH_WATER,
    );
    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    expect(result.doomed).toEqual([]);
  });

  test('excludes foreign scoped images from broken-state deletion', () => {
    const owned = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const foreign = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const all = padToOrgSize([owned, foreign], QUOTA_GC_ORG_HIGH_WATER);

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    const reaped = result.doomed.map((candidate) => candidate.snapshot.name);
    expect(reaped).toContain(owned.name);
    expect(reaped).not.toContain(foreign.name);
  });

  test('groups superseded scoped tips by database, project, and template', () => {
    const current = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip2', BASE, 'default'),
      { lastUsedAt: ago(1) },
    );
    const predecessor = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { lastUsedAt: ago(5) },
    );
    const otherTemplate = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'custom'),
      { lastUsedAt: ago(5) },
    );
    const otherProject = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ_B, 'tip1', BASE, 'default'),
      { lastUsedAt: ago(5) },
    );
    const foreign = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ, 'tip0', BASE, 'default'),
      { lastUsedAt: ago(6) },
    );
    const all = padToOrgSize(
      [current, predecessor, otherTemplate, otherProject, foreign],
      QUOTA_GC_ORG_HIGH_WATER,
    );

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    expect(result.doomed.map((candidate) => candidate.snapshot.name)).toEqual([
      predecessor.name,
    ]);
  });

  test('excludes foreign scoped images from superseded-tip deletion', () => {
    const foreignCurrent = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ, 'tip2', BASE, 'default'),
      { lastUsedAt: ago(1) },
    );
    const foreignPredecessor = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ, 'tip1', BASE, 'default'),
      { lastUsedAt: ago(5) },
    );
    const all = padToOrgSize(
      [foreignCurrent, foreignPredecessor],
      QUOTA_GC_ORG_HIGH_WATER,
    );

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    expect(result.doomed).toEqual([]);
  });

  test('excludes foreign scoped images from idle deletion', () => {
    const owned = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { lastUsedAt: ago(20) },
    );
    const foreign = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ, 'tip1', BASE, 'default'),
      { lastUsedAt: ago(30) },
    );
    const all = padToOrgSize([owned, foreign], QUOTA_GC_ORG_HIGH_WATER);

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    const reaped = result.doomed.map((candidate) => candidate.snapshot.name);
    expect(reaped).toContain(owned.name);
    expect(reaped).not.toContain(foreign.name);
  });

  test('excludes foreign scoped images from LRU deletion', () => {
    const owned = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { lastUsedAt: new Date(NOW - 10 * 3_600_000).toISOString() },
    );
    const foreign = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ_B, 'tip1', BASE, 'default'),
      { lastUsedAt: new Date(NOW - 50 * 3_600_000).toISOString() },
    );
    const all = padToOrgSize([owned, foreign], QUOTA_GC_ORG_TARGET + 1);

    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    expect(result.doomed.map((candidate) => candidate.snapshot.name)).toEqual([
      owned.name,
    ]);
    expect(result.doomed[0]?.reason).toContain('LRU eviction');
  });

  test('fails closed for every scoped image when ownership is unavailable', () => {
    const first = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const second = snap(
      scopedPerProjectWarmImageName(SCOPE_B, PROJ_B, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const all = padToOrgSize([first, second], QUOTA_GC_ORG_HIGH_WATER);
    const result = selectSnapshotsToReap({ all, referenced: new Set(), now: NOW });
    expect(result.doomed).toEqual([]);
  });

  test('excludes scoped images when pin protection is unavailable', () => {
    const owned = snap(
      scopedPerProjectWarmImageName(SCOPE_A, PROJ, 'tip1', BASE, 'default'),
      { state: 'error' },
    );
    const all = padToOrgSize([owned], QUOTA_GC_ORG_HIGH_WATER);
    const result = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      ppwarmPinProtectionAvailable: false,
      ownedPpwarmDataPlaneScope: SCOPE_A,
      now: NOW,
    });
    expect(result.doomed).toEqual([]);
  });
});
