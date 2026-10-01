/**
 * The managed-skill overlay is per project flag set: flags off ⇒ no
 * human-messaging wording anywhere agent-facing; flag on ⇒ guidance present.
 * The caller's flags come from `callerOverlayFlags` (DB), stubbed here by a
 * header so the WIRING of the three routes is what is under test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../caller-flags', () => ({
  callerOverlayFlags: async (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-test-flags')?.split(',').filter(Boolean) ?? [],
}));

const { runtimeAssetsApp } = await import('../index');
const { skillsApp } = await import('../../skills');
const { OVERLAY_FLAGS, managedSkillOverlayFor, normalizeRunningSkillsHash } = await import('../managed-skills');
const { _resetRuntimeAssetsCache, runtimeAssetsManifest } = await import('../manifest');

const BANNED = ['kortix send', 'Asked you', 'MESSAGE from session', 'ASK from'];
const ON = { 'x-test-flags': 'human_messaging' };

const app = new Hono();
app.route('/v1/runtime-assets', runtimeAssetsApp as never);
app.route('/v1/skills', skillsApp as never);

beforeEach(() => _resetRuntimeAssetsCache());

describe('managed skill overlay per flag set', () => {
  test('OVERLAY_FLAGS is exactly the flag set the templates use', () => {
    expect([...OVERLAY_FLAGS]).toEqual(['human_messaging']);
  });

  test('flags off: no overlay file mentions human messaging', () => {
    for (const f of managedSkillOverlayFor([]).files)
      for (const term of BANNED) expect([f.path, f.content.includes(term)]).toEqual([f.path, false]);
  });

  test('flag on: different hash, guidance present', () => {
    const off = managedSkillOverlayFor([]);
    const on = managedSkillOverlayFor(['human_messaging']);
    expect(on.hash).not.toBe(off.hash);
    expect(on.files.find((f) => f.path === 'kortix-system/SKILL.md')!.content).toContain('kortix send');
  });

  test('unknown flags are ignored; same set ⇒ same memoized object', () => {
    expect(managedSkillOverlayFor(['nope'])).toBe(managedSkillOverlayFor([]));
    expect(managedSkillOverlayFor(['human_messaging'])).toBe(managedSkillOverlayFor(['human_messaging']));
  });

  test('a flag-on running hash normalises to the flags-off hash; other hashes stay', () => {
    const off = managedSkillOverlayFor([]).hash;
    expect(normalizeRunningSkillsHash(managedSkillOverlayFor(['human_messaging']).hash)).toBe(off);
    expect(normalizeRunningSkillsHash('deadbeef')).toBe('deadbeef');
    expect(normalizeRunningSkillsHash(null)).toBeNull();
  });
});

describe('routes serve the caller project flag set', () => {
  test('GET /managed-skills: off vs on', async () => {
    const off = (await (await app.request('/v1/runtime-assets/managed-skills')).json()) as any;
    const on = (await (await app.request('/v1/runtime-assets/managed-skills', { headers: ON })).json()) as any;
    const sys = (j: any) => j.files.find((f: any) => f.path === 'kortix-system/SKILL.md').content as string;
    expect(sys(off)).not.toContain('kortix send');
    expect(sys(on)).toContain('kortix send');
    expect(on.hash).toBe(managedSkillOverlayFor(['human_messaging']).hash);
    expect(off.hash).toBe(managedSkillOverlayFor([]).hash);
  });

  test('GET /managed-skills: ETag of one flag set does not 304 the other', async () => {
    const off = await app.request('/v1/runtime-assets/managed-skills');
    const res = await app.request('/v1/runtime-assets/managed-skills', {
      headers: { ...ON, 'If-None-Match': off.headers.get('ETag')! },
    });
    expect(res.status).toBe(200);
  });

  test('manifest hash follows the flag set; its component agrees', () => {
    return Promise.all([runtimeAssetsManifest([]), runtimeAssetsManifest(['human_messaging'])]).then(([off, on]) => {
      expect(on.managed_skills_hash).not.toBe(off.managed_skills_hash);
      expect(on.components['managed-skills'].hash).toBe(on.managed_skills_hash);
    });
  });

  test('GET /v1/skills/kortix-system: off vs on (body and reference)', async () => {
    const off = (await (await app.request('/v1/skills/kortix-system')).json()) as any;
    const on = (await (await app.request('/v1/skills/kortix-system', { headers: ON })).json()) as any;
    expect(off.body).not.toContain('kortix send');
    expect(on.body).toContain('kortix send');
    const ref = 'references/kortix/kortix-cli.md';
    const offRef = (await (await app.request(`/v1/skills/kortix-system/file?path=${ref}`)).json()) as any;
    const onRef = (await (await app.request(`/v1/skills/kortix-system/file?path=${ref}`, { headers: ON })).json()) as any;
    expect(offRef.content).not.toContain('kortix send');
    expect(onRef.content).toContain('kortix send');
  });
});
