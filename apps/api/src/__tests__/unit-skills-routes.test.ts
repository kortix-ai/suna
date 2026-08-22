import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { skillsApp } from '../skills';

// Mounted the same way index.ts mounts it, minus combinedAuth — the auth gate is
// index.ts's `app.use('/v1/skills', ...)` registration; what is asserted here is
// the contract the CLI and any harness agent read.
const app = new OpenAPIHono();
app.route('/v1/skills', skillsApp);

const get = (path: string) => app.request(path);

describe('GET /v1/skills', () => {
  test('lists every system skill with a description and no body', async () => {
    const res = await get('/v1/skills');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(body.skills.length);
    expect(body.skills.map((s: any) => s.name)).toContain('kortix-system');
    for (const s of body.skills) {
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.body).toBeUndefined();
      expect(typeof s.referenceCount).toBe('number');
    }
  });
});

describe('GET /v1/skills/:name', () => {
  test('returns the complete SKILL.md body plus reference paths, no contents', async () => {
    const res = await get('/v1/skills/kortix-system');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe('kortix-system');
    expect(body.body).toContain('<skill name="kortix-system">');
    expect(body.references.length).toBeGreaterThan(0);
    for (const f of body.references) {
      expect(typeof f.path).toBe('string');
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.content).toBeUndefined();
    }
  });

  test('?full=1 inlines every reference file', async () => {
    const res = await get('/v1/skills/kortix-system?full=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const f of body.references) {
      expect(typeof f.content).toBe('string');
      expect(f.content.length).toBe(f.bytes);
    }
  });

  test('a skill with no references still returns an array, not undefined', async () => {
    const res = await get('/v1/skills/kortix-cli');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.references)).toBe(true);
  });

  test('unknown skill 404s with the error envelope', async () => {
    const res = await get('/v1/skills/not-a-skill');
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe(true);
    expect(body.message).toContain('not-a-skill');
  });

  test('a non-managed starter skill is not reachable here', async () => {
    expect((await get('/v1/skills/pdf')).status).toBe(404);
  });
});

describe('GET /v1/skills/:name/file', () => {
  test('returns one reference file by its listed path', async () => {
    const detail = (await (await get('/v1/skills/kortix-system')).json()) as any;
    const target = detail.references[0].path;
    const res = await get(`/v1/skills/kortix-system/file?path=${encodeURIComponent(target)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.path).toBe(target);
    expect(body.content.length).toBe(detail.references[0].bytes);
  });

  test('missing path is a 400, not a 500', async () => {
    const res = await get('/v1/skills/kortix-system/file');
    expect(res.status).toBe(400);
  });

  test('traversal attempts 404 instead of escaping the skill', async () => {
    const res = await get(
      `/v1/skills/kortix-system/file?path=${encodeURIComponent('../../../../etc/passwd')}`,
    );
    expect(res.status).toBe(404);
  });

  test('the /file route is not shadowed by the /:name route', async () => {
    const res = await get('/v1/skills/kortix-system/file?path=SKILL.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.content).toContain('<skill name="kortix-system">');
  });
});
