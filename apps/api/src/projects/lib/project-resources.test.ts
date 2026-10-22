import { describe, expect, test } from 'bun:test';
import { ttlMemo } from '../../shared/ttl-memo';
import { CONFIG_WITH_FILES_TTL_MS, skillSlugFromPath } from './project-resources';

/**
 * `loadConfigWithFilesCached` (project-resources.ts) exists so a read that
 * enumerates MANY projects per request — the IAM agent-identity picker,
 * apps/api/src/accounts/iam/custom-roles.ts — doesn't re-clone/re-list every
 * project's repo on every call. `ttlMemo` is bypassed under `bun test` by
 * design (unit tests must never bleed cache state across cases), so — same
 * pattern as `unit-sandbox-health-budget.test.ts`'s "poll caching" section —
 * these tests exercise the SAME primitive with the SAME configuration
 * (`enableInTests: true`) to pin the caching contract the route relies on,
 * without needing a real DB/git mirror.
 */
describe('loadConfigWithFilesCached TTL contract', () => {
  test('the TTL is short enough to show a just-pushed change soon, long enough to collapse a burst', () => {
    // Long enough that a many-project enumeration (up to 50 projects) firing
    // within the same admin session collapses onto one read per project.
    expect(CONFIG_WITH_FILES_TTL_MS).toBeGreaterThanOrEqual(10_000);
    // Short enough that a just-pushed agent/skill is visible on the next
    // click, not "eventually, whenever the cache happens to expire".
    expect(CONFIG_WITH_FILES_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  const memo = (loader: (projectId: string) => Promise<number>) =>
    ttlMemo({
      ttlMs: CONFIG_WITH_FILES_TTL_MS,
      keyFn: (projectId: string) => projectId,
      loader,
      enableInTests: true,
    });

  test('repeat reads for one project share a single underlying load', async () => {
    let calls = 0;
    const cached = memo(async () => ++calls);

    expect(await cached('p1')).toBe(1);
    expect(await cached('p1')).toBe(1);
    expect(await cached('p1')).toBe(1);
    expect(calls).toBe(1);
  });

  test('concurrent reads for one project collapse to one load, not one each', async () => {
    // This is exactly the shape the agent-identities picker creates: up to
    // 50 projects read with bounded concurrency, and the SAME project can be
    // requested again by a second admin (or a second browser tab) while the
    // first read is still in flight.
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return calls;
    });

    const answers = await Promise.all([cached('p1'), cached('p1'), cached('p1')]);

    expect(calls).toBe(1);
    expect(answers).toEqual([1, 1, 1]);
  });

  test('two projects never share a cache entry', async () => {
    let calls = 0;
    const cached = memo(async () => ++calls);

    expect(await cached('p1')).toBe(1);
    expect(await cached('p2')).toBe(2);
    expect(await cached('p1')).toBe(1);
  });

  test('a failed load is never cached — the next read retries', async () => {
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      if (calls === 1) throw new Error('repo unreachable');
      return calls;
    });

    await expect(cached('p1')).rejects.toThrow('repo unreachable');
    expect(await cached('p1')).toBe(2);
  });
});

describe('skillSlugFromPath', () => {
  test('reads the slug in the root layout and the legacy one', () => {
    expect(skillSlugFromPath('skills/deploy/SKILL.md')).toBe('deploy');
    expect(skillSlugFromPath('.kortix/opencode/skills/deploy/SKILL.md')).toBe('deploy');
    expect(skillSlugFromPath('agents/deploy.md')).toBeNull();
  });
});
