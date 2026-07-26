import { describe, expect, test } from 'bun:test';
import { PPWARM_PREFIX, excludePinnedTargets, legacyPerProjectWarmImageName, perProjectWarmImageName, ppwarmReapTargets, proj8, tpl8 } from './ppwarm-names';
import { ppwarmProj8, ppwarmTpl8 } from './quota-gc-select';

const PROJ_A = '9ee8bc9c-5108-437f-a01f-6c5e26f2062c';
const PROJ_B_COLLIDING = '9ee8bc9c-aaaa-bbbb-cccc-dddddddddddd';
const BASE = 'kortix-default-e881f000eae5';

describe('perProjectWarmImageName — template-scoped naming', () => {
  test('produces the new (proj8, tpl8, hash12) shape', () => {
    const name = perProjectWarmImageName(PROJ_A, 'tip1', BASE, 'my-template');
    const rest = name.slice(PPWARM_PREFIX.length);
    const segments = rest.split('-');
    expect(segments.length).toBe(3);
    expect(segments[0]).toBe(proj8(PROJ_A));
    expect(segments[1]).toBe(tpl8('my-template'));
    expect(segments[2]).toMatch(/^[0-9a-f]{12}$/);
  });

  test('omitting templateSlug defaults to the platform default template', () => {
    const withDefault = perProjectWarmImageName(PROJ_A, 'tip1', BASE);
    const explicitDefault = perProjectWarmImageName(PROJ_A, 'tip1', BASE, 'default');
    expect(withDefault).toBe(explicitDefault);
  });

  test('two templates for the same (project, tip, base) get different names', () => {
    const a = perProjectWarmImageName(PROJ_A, 'tip1', BASE, 'default');
    const b = perProjectWarmImageName(PROJ_A, 'tip1', BASE, 'custom-tpl');
    expect(a).not.toBe(b);
    const aTpl = a.slice(PPWARM_PREFIX.length).split('-')[1];
    const bTpl = b.slice(PPWARM_PREFIX.length).split('-')[1];
    expect(aTpl).not.toBe(bTpl);
  });

  test('the same template always yields the same tpl8, independent of tip/base', () => {
    const a = perProjectWarmImageName(PROJ_A, 'tipX', 'kortix-default-r1', 'default');
    const b = perProjectWarmImageName(PROJ_A, 'tipY', 'kortix-default-r2', 'default');
    const aTpl = a.slice(PPWARM_PREFIX.length).split('-')[1];
    const bTpl = b.slice(PPWARM_PREFIX.length).split('-')[1];
    expect(aTpl).toBe(bTpl);
  });
});

describe('ppwarmReapTargets — template-scoped reap', () => {
  test('two templates in one project never reap each other', () => {
    const defaultCur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const defaultOld = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'default');
    const customCur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'custom-tpl');
    const customOld = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'custom-tpl');
    const all = [defaultCur, defaultOld, customCur, customOld];

    const targetsForDefaultBake = ppwarmReapTargets(PROJ_A, defaultCur, all);
    expect(targetsForDefaultBake).toEqual([defaultOld]);
    expect(targetsForDefaultBake).not.toContain(customOld);
    expect(targetsForDefaultBake).not.toContain(customCur);

    const targetsForCustomBake = ppwarmReapTargets(PROJ_A, customCur, all);
    expect(targetsForCustomBake).toEqual([customOld]);
    expect(targetsForCustomBake).not.toContain(defaultOld);
    expect(targetsForCustomBake).not.toContain(defaultCur);
  });

  test('a moved tip of the SAME template is still reaped (regression guard)', () => {
    const cur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const old = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'default');
    expect(ppwarmReapTargets(PROJ_A, cur, [cur, old])).toEqual([old]);
    expect(ppwarmReapTargets(PROJ_A, cur, [cur])).toEqual([]);
  });

  test('old-format names are never selected once the current tip is new-format', () => {
    const cur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const legacyName = `${PPWARM_PREFIX}${proj8(PROJ_A)}-legacyhash12`;
    const targets = ppwarmReapTargets(PROJ_A, cur, [cur, legacyName]);
    expect(targets).not.toContain(legacyName);
  });

  test('an old-format currentName falls back to the pre-migration proj8-only scope', () => {
    const legacyCurrent = `${PPWARM_PREFIX}${proj8(PROJ_A)}-aaaaaaaaaaaa`;
    const legacySuperseded = `${PPWARM_PREFIX}${proj8(PROJ_A)}-bbbbbbbbbbbb`;
    const newFormatSibling = perProjectWarmImageName(PROJ_A, 'tipZ', BASE, 'default');
    const targets = ppwarmReapTargets(PROJ_A, legacyCurrent, [legacyCurrent, legacySuperseded, newFormatSibling]);
    expect(targets.sort()).toEqual([legacySuperseded, newFormatSibling].sort());
  });

  test('tombstones are excluded regardless of format', () => {
    const cur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const old = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'default');
    const tombstoned = `${old}__deleted_tpl_01ABC`;
    const targets = ppwarmReapTargets(PROJ_A, cur, [cur, tombstoned]);
    expect(targets).toEqual([]);
  });

  test('a proj8 collision between two different projects is still harmless', () => {
    expect(proj8(PROJ_A)).toBe(proj8(PROJ_B_COLLIDING));
    const aCur = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const bPinnedLive = perProjectWarmImageName(PROJ_B_COLLIDING, 'tipQ', BASE, 'default');
    const raw = ppwarmReapTargets(PROJ_A, aCur, [aCur, bPinnedLive]);
    expect(raw).toContain(bPinnedLive);
    const guarded = excludePinnedTargets(raw, new Set([bPinnedLive]));
    expect(guarded).not.toContain(bPinnedLive);
  });
});

describe('legacyPerProjectWarmImageName — migration fallback', () => {
  const PROJ = '11112222-3333-4444-5555-666677778888';
  const TIP = 'a'.repeat(40);
  const BASE = 'kortix-default-c17604ba585c';

  test('reproduces the pre-migration two-segment shape', () => {
    const legacy = legacyPerProjectWarmImageName(PROJ, TIP, BASE);
    expect(legacy.startsWith(PPWARM_PREFIX)).toBe(true);
    expect(legacy.slice(PPWARM_PREFIX.length).split('-')).toHaveLength(2);
  });

  test('is a different name from the new template-scoped one', () => {
    expect(legacyPerProjectWarmImageName(PROJ, TIP, BASE)).not.toBe(
      perProjectWarmImageName(PROJ, TIP, BASE, 'default'),
    );
  });

  test('hash excludes the template slug, unlike the new format', () => {
    const a = legacyPerProjectWarmImageName(PROJ, TIP, BASE);
    const b = legacyPerProjectWarmImageName(PROJ, TIP, BASE);
    expect(a).toBe(b);
    expect(perProjectWarmImageName(PROJ, TIP, BASE, 'default')).not.toBe(
      perProjectWarmImageName(PROJ, TIP, BASE, 'custom'),
    );
  });

  test('moves with the tip, so a stale legacy name is never served for a moved branch', () => {
    expect(legacyPerProjectWarmImageName(PROJ, TIP, BASE)).not.toBe(
      legacyPerProjectWarmImageName(PROJ, 'b'.repeat(40), BASE),
    );
  });

  test('a legacy name is not an on-bake reap target of a new-format tip', () => {
    const legacy = legacyPerProjectWarmImageName(PROJ, TIP, BASE);
    const current = perProjectWarmImageName(PROJ, 'c'.repeat(40), BASE, 'default');
    expect(ppwarmReapTargets(PROJ, current, [legacy, current])).not.toContain(legacy);
  });

  test('a legacy name is still recognised as this project ppwarm by the quota sweeps', () => {
    const legacy = legacyPerProjectWarmImageName(PROJ, TIP, BASE);
    expect(ppwarmProj8(legacy)).toBe(proj8(PROJ));
    expect(ppwarmTpl8(legacy)).toBeNull();
  });
});
