import { describe, expect, test } from 'bun:test';
import { ppwarmReapTargets, perProjectWarmImageName } from '../snapshots/ppwarm-names';

// proj8 = first 8 hex chars of the projectId with dashes stripped.
const PROJ_A = '9ee8bc9c-5108-437f-a01f-6c5e26f2062c'; // proj8 = 9ee8bc9c
const CURRENT = 'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa';

describe('ppwarmReapTargets — on-bake reap selector', () => {
  test('reaps superseded tips of the same project, keeps the current', () => {
    const names = [
      'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa', // current
      'kortix-ppwarm-9ee8bc9c-bbbbbbbbbbbb', // superseded
      'kortix-ppwarm-9ee8bc9c-cccccccccccc', // superseded
    ];
    expect(ppwarmReapTargets(PROJ_A, CURRENT, names).sort()).toEqual([
      'kortix-ppwarm-9ee8bc9c-bbbbbbbbbbbb',
      'kortix-ppwarm-9ee8bc9c-cccccccccccc',
    ]);
  });

  test('never touches another project (proj8-scoped)', () => {
    const names = [
      'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa', // current, project A
      'kortix-ppwarm-dc42fe89-bbbbbbbbbbbb', // project B — off-limits
      'kortix-ppwarm-dc42fe89-cccccccccccc', // project B — off-limits
    ];
    expect(ppwarmReapTargets(PROJ_A, CURRENT, names)).toEqual([]);
  });

  test('never targets the shared base/default, custom tpls, or prod stateful warm', () => {
    const names = [
      'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa', // current
      'kortix-default-e881f000eae5', // shared base
      'kortix-tpl-9ee8bc9c-deadbeef1234', // custom template
      'kortix-wproj-9ee8bc9c-cafebabe5678', // prod stateful warm (daytona)
      'kortix-wprojpt-9ee8bc9c-0badc0de9999', // prod stateful warm (platinum)
    ];
    expect(ppwarmReapTargets(PROJ_A, CURRENT, names)).toEqual([]);
  });

  test('idempotent — only the current tip (or nothing) present → nothing reaped', () => {
    expect(ppwarmReapTargets(PROJ_A, CURRENT, [CURRENT])).toEqual([]);
    expect(ppwarmReapTargets(PROJ_A, CURRENT, [])).toEqual([]);
  });

  test('integrates with perProjectWarmImageName: a moved tip makes the old image a target, a re-bake does not', () => {
    const base = 'kortix-default-e881f000eae5';
    const cur = perProjectWarmImageName(PROJ_A, 'tipB', base);
    const old = perProjectWarmImageName(PROJ_A, 'tipA', base);
    expect(cur.startsWith('kortix-ppwarm-9ee8bc9c-')).toBe(true);
    expect(old).not.toBe(cur);
    // moved tip: the old image is a reap target, the current is kept
    expect(ppwarmReapTargets(PROJ_A, cur, [cur, old])).toEqual([old]);
    // re-bake of the same tip: nothing to reap (live tip safe)
    expect(ppwarmReapTargets(PROJ_A, cur, [cur])).toEqual([]);
  });
});
