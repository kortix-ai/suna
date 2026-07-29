import { describe, expect, test } from 'bun:test';
import { perProjectWarmImageName, proj8 } from './ppwarm-names';
import { QUOTA_GC_ORG_HIGH_WATER, ppwarmTpl8, selectSnapshotsToReap, type SnapshotLike } from './quota-gc-select';

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
const BASE = 'kortix-default-r1';

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
    const all = padToOrgSize(
      [
        snap(`kortix-ppwarm-${proj8(PROJ)}-newesttip1`, { lastUsedAt: ago(1) }),
        snap(`kortix-ppwarm-${proj8(PROJ)}-oldertipp2`, { lastUsedAt: ago(5) }),
      ],
      QUOTA_GC_ORG_HIGH_WATER,
    );
    const res = selectSnapshotsToReap({ all, referenced: new Set(), now: NOW });
    const reaped = res.doomed.map((d) => d.snapshot.name);
    expect(reaped).toContain(`kortix-ppwarm-${proj8(PROJ)}-oldertipp2`);
    expect(reaped).not.toContain(`kortix-ppwarm-${proj8(PROJ)}-newesttip1`);
  });
});
