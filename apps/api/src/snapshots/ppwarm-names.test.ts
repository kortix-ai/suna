import { describe, expect, test } from 'bun:test';
import {
  PPWARM_PREFIX,
  SCOPED_PPWARM_PREFIX,
  dataPlaneScopeFromSupabaseUrl,
  excludePinnedTargets,
  isExactPpwarmImageName,
  legacyPerProjectWarmImageName,
  parseExactPpwarmImageName,
  perProjectWarmImageName,
  ppwarmReapTargets,
  proj8,
  scopedPerProjectWarmImageName,
  tpl8,
} from './ppwarm-names';
import { ppwarmProj8, ppwarmTpl8 } from './quota-gc-select';

const PROJ_A = '9ee8bc9c-5108-437f-a01f-6c5e26f2062c';
const PROJ_B_COLLIDING = '9ee8bc9c-aaaa-bbbb-cccc-dddddddddddd';
const BASE = 'kortix-default-e881f000eae5';
const DB_SCOPE_A = dataPlaneScopeFromSupabaseUrl(
  'https://api-a.supabase.example/kortix?ignored=true#ignored',
);
const DB_SCOPE_B = dataPlaneScopeFromSupabaseUrl(
  'https://api-b.supabase.example/kortix',
);

describe('dataPlaneScopeFromSupabaseUrl', () => {
  test('returns the same twelve-hex scope for the same data-plane endpoint', () => {
    const raw = 'https://api.supabase.example/kortix';
    expect(dataPlaneScopeFromSupabaseUrl(raw)).toBe(dataPlaneScopeFromSupabaseUrl(raw));
    expect(dataPlaneScopeFromSupabaseUrl(raw)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('ignores credentials, query, hash, host casing, and a terminal DNS dot', () => {
    const first = dataPlaneScopeFromSupabaseUrl(
      'https://first:secret@API.SUPABASE.EXAMPLE./kortix/?one=1#one',
    );
    const second = dataPlaneScopeFromSupabaseUrl(
      'https://second:rotated@api.supabase.example/kortix?two=2#two',
    );
    expect(first).toBe(second);
  });

  test('distinguishes protocol, host, non-default port, and endpoint path', () => {
    const baseline = dataPlaneScopeFromSupabaseUrl(
      'https://api.supabase.example/kortix',
    );
    const alternatives = [
      'http://api.supabase.example/kortix',
      'https://other.supabase.example/kortix',
      'https://api.supabase.example:8443/kortix',
      'https://api.supabase.example/other',
    ].map((raw) => dataPlaneScopeFromSupabaseUrl(raw));
    expect(new Set([baseline, ...alternatives]).size).toBe(alternatives.length + 1);
  });

  test('does not collapse an encoded path separator into a routed path separator', () => {
    expect(dataPlaneScopeFromSupabaseUrl('https://api.example/tenant%2Fa', 'dev')).not.toBe(
      dataPlaneScopeFromSupabaseUrl('https://api.example/tenant/a', 'dev'),
    );
  });

  test('canonicalizes percent-encoding without decoding reserved separators', () => {
    expect(dataPlaneScopeFromSupabaseUrl('https://api.example/k%6frtix/%7euser', 'dev')).toBe(
      dataPlaneScopeFromSupabaseUrl('https://api.example/kortix/~user', 'dev'),
    );
    expect(dataPlaneScopeFromSupabaseUrl('https://api.example/tenant%2fa', 'dev')).toBe(
      dataPlaneScopeFromSupabaseUrl('https://api.example/tenant%2Fa', 'dev'),
    );
  });

  test('distinguishes deployment environments even when an internal URL is shared', () => {
    const raw = 'http://supabase-kong:8000';
    expect(dataPlaneScopeFromSupabaseUrl(raw, 'dev')).not.toBe(
      dataPlaneScopeFromSupabaseUrl(raw, 'staging'),
    );
    expect(dataPlaneScopeFromSupabaseUrl(raw, ' DEV ')).toBe(
      dataPlaneScopeFromSupabaseUrl(raw, 'dev'),
    );
  });
});

describe('scopedPerProjectWarmImageName', () => {
  test('produces the exact scoped shape within the provider limit', () => {
    const name = scopedPerProjectWarmImageName(
      DB_SCOPE_A,
      PROJ_A,
      'tip1',
      BASE,
      'my-template',
    );
    const segments = name.slice(SCOPED_PPWARM_PREFIX.length).split('-');
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.length)).toEqual([12, 12, 16, 16]);
    expect(name.length).toBe(64);
    expect(name).toMatch(
      /^kpp2-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{16}-[0-9a-f]{16}$/,
    );
  });

  test('is deterministic and includes every full identity input in the content hash', () => {
    const args = [DB_SCOPE_A, PROJ_A, 'tip1', BASE, 'default'] as const;
    const baseline = scopedPerProjectWarmImageName(...args);
    const hash = (name: string) => name.split('-').at(-1);
    expect(scopedPerProjectWarmImageName(...args)).toBe(baseline);
    expect(hash(scopedPerProjectWarmImageName(DB_SCOPE_B, PROJ_A, 'tip1', BASE, 'default'))).not.toBe(hash(baseline));
    expect(
      hash(scopedPerProjectWarmImageName(DB_SCOPE_A, `${PROJ_A}x`, 'tip1', BASE, 'default')),
    ).not.toBe(hash(baseline));
    expect(hash(scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tip2', BASE, 'default'))).not.toBe(hash(baseline));
    expect(
      hash(scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tip1', `${BASE}x`, 'default')),
    ).not.toBe(hash(baseline));
    expect(hash(scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tip1', BASE, 'custom'))).not.toBe(hash(baseline));
  });

  test('separates projects that collide under the legacy proj8 key', () => {
    expect(proj8(PROJ_A)).toBe(proj8(PROJ_B_COLLIDING));
    const a = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tip1', BASE, 'default');
    const b = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_B_COLLIDING, 'tip1', BASE, 'default');
    expect(parseExactPpwarmImageName(a)?.projectKey).not.toBe(
      parseExactPpwarmImageName(b)?.projectKey,
    );
    expect(a).not.toBe(b);
  });

  test('keeps the image identity stable across endpoint credential rotation', () => {
    const before = dataPlaneScopeFromSupabaseUrl(
      'https://kortix:old@api.supabase.example/kortix?first=1',
    );
    const after = dataPlaneScopeFromSupabaseUrl(
      'https://kortix:new@api.supabase.example/kortix?second=2',
    );
    expect(
      scopedPerProjectWarmImageName(before, PROJ_A, 'tip1', BASE, 'default'),
    ).toBe(scopedPerProjectWarmImageName(after, PROJ_A, 'tip1', BASE, 'default'));
  });
});

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

  test('a scoped current image reaps only scoped predecessors with the same ownership keys', () => {
    const current = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tipB', BASE, 'default');
    const predecessor = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tipA', BASE, 'default');
    const foreignDatabase = scopedPerProjectWarmImageName(DB_SCOPE_B, PROJ_A, 'tipA', BASE, 'default');
    const foreignProject = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_B_COLLIDING, 'tipA', BASE, 'default');
    const foreignTemplate = scopedPerProjectWarmImageName(DB_SCOPE_A, PROJ_A, 'tipA', BASE, 'custom');
    const currentUnscoped = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'default');
    const legacy = legacyPerProjectWarmImageName(PROJ_A, 'tipA', BASE);

    expect(
      ppwarmReapTargets(PROJ_A, current, [
        current,
        predecessor,
        foreignDatabase,
        foreignProject,
        foreignTemplate,
        currentUnscoped,
        legacy,
      ]),
    ).toEqual([predecessor]);
  });

  test('reaping fails closed for an unrecognised current name', () => {
    const valid = perProjectWarmImageName(PROJ_A, 'tipA', BASE, 'default');
    expect(
      ppwarmReapTargets(PROJ_A, `${PPWARM_PREFIX}${proj8(PROJ_A)}-not-a-live-name`, [
        valid,
      ]),
    ).toEqual([]);
  });

  test('unscoped and legacy current names must belong to the supplied project', () => {
    const projectAUnscoped = perProjectWarmImageName(
      PROJ_A,
      'tipA',
      BASE,
      'default',
    );
    const projectALegacy = legacyPerProjectWarmImageName(PROJ_A, 'tipA', BASE);
    const projectBUnscoped = perProjectWarmImageName(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'tipB',
      BASE,
      'default',
    );
    const projectBLegacy = legacyPerProjectWarmImageName(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'tipB',
      BASE,
    );

    expect(ppwarmReapTargets(PROJ_A, projectBUnscoped, [projectAUnscoped])).toEqual([]);
    expect(ppwarmReapTargets(PROJ_A, projectBLegacy, [projectALegacy])).toEqual([]);
  });

  test('reaping ignores malformed candidates inside each namespace shape', () => {
    const scopedCurrent = scopedPerProjectWarmImageName(
      DB_SCOPE_A,
      PROJ_A,
      'tipB',
      BASE,
      'default',
    );
    const unscopedCurrent = perProjectWarmImageName(PROJ_A, 'tipB', BASE, 'default');
    const legacyCurrent = legacyPerProjectWarmImageName(PROJ_A, 'tipB', BASE);
    const malformed = [
      `${scopedCurrent}-extra`,
      `${unscopedCurrent}-extra`,
      `${legacyCurrent}-extra`,
    ];

    expect(ppwarmReapTargets(PROJ_A, scopedCurrent, malformed)).toEqual([]);
    expect(ppwarmReapTargets(PROJ_A, unscopedCurrent, malformed)).toEqual([]);
    expect(ppwarmReapTargets(PROJ_A, legacyCurrent, malformed)).toEqual([]);
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

describe('isExactPpwarmImageName', () => {
  test('accepts scoped, current, and legacy generated names', () => {
    expect(
      isExactPpwarmImageName(
        scopedPerProjectWarmImageName(
          DB_SCOPE_A,
          PROJ_A,
          'a'.repeat(40),
          BASE,
          'default',
        ),
      ),
    ).toBe(true);
    expect(
      isExactPpwarmImageName(
        perProjectWarmImageName(PROJ_A, 'a'.repeat(40), BASE, 'default'),
      ),
    ).toBe(true);
    expect(
      isExactPpwarmImageName(
        legacyPerProjectWarmImageName(PROJ_A, 'a'.repeat(40), BASE),
      ),
    ).toBe(true);
  });

  test.each([
    'kortix-default-e881f000eae5',
    'kortix-ppwarm-',
    'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaa',
    'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaaa',
    'kortix-ppwarm-9ee8bc9c-zzzzzzzzzzzz',
    'kortix-ppwarm-9EE8BC9C-aaaaaaaaaaaa',
    'kortix-ppwarm-9ee8bc9c-37a8eec1-aaaaaaaaaaaa-extra',
    'kortix-ppwarm-123456789abc-123456789abc-1234567890abcdef-1234567890abcdef',
    'kpp2-123456789abc-123456789abc-1234567890abcdef-1234567890abcde',
    'kpp2-123456789abc-123456789abc-1234567890abcdef-1234567890abcdef0',
    'kpp2-123456789abc-123456789abc-1234567890abcdez-1234567890abcdef',
    'kortix-ppwarm-9ee8bc9c-37a8eec1-aaaaaaaaaaaa__deleted_tpl_1',
    '../kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa',
  ])('rejects %s', (name) => {
    expect(isExactPpwarmImageName(name)).toBe(false);
  });
});

describe('parseExactPpwarmImageName', () => {
  test('returns one authoritative ownership tuple for every supported format', () => {
    const scoped = scopedPerProjectWarmImageName(
      DB_SCOPE_A,
      PROJ_A,
      'tip',
      BASE,
      'default',
    );
    const unscoped = perProjectWarmImageName(PROJ_A, 'tip', BASE, 'default');
    const legacy = legacyPerProjectWarmImageName(PROJ_A, 'tip', BASE);

    expect(parseExactPpwarmImageName(scoped)).toMatchObject({
      format: 'scoped',
      dataPlaneScope: DB_SCOPE_A,
    });
    expect(parseExactPpwarmImageName(unscoped)).toMatchObject({
      format: 'unscoped',
      dataPlaneScope: null,
    });
    expect(parseExactPpwarmImageName(legacy)).toMatchObject({
      format: 'legacy',
      dataPlaneScope: null,
      templateKey: null,
    });
    expect(parseExactPpwarmImageName(`${scoped}-extra`)).toBeNull();
  });
});
