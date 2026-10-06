/**
 * Kortix system skills — `/v1/skills` (apps/api/src/skills/). Maps 1:1 to spec
 * §0 "Kortix system skills" (SKILL-*).
 *
 * These routes are the reason an agent in any harness can drive Kortix with
 * nothing but the `kortix` binary and a token, so the properties worth asserting
 * black-box are: authed-not-public, the list is choosable without bodies, the
 * body is complete, and a name/path that is not a managed skill cannot be used
 * to read anything else. Read-only, no fixtures, no sandboxes.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';

// The one skill guaranteed to exist on every deploy — it is the entry pointer
// every other Kortix skill and the seeded project scaffold reference by name.
const KNOWN_SKILL = 'kortix-system';

async function createProjectPat(ctx: FlowContext, label: string) {
  const project = await ctx.fixtures.project();
  const response = await ctx.client.as(ctx.P.OWNER).post(
    '/v1/projects/:projectId/cli-token',
    { name: ctx.fixtures.name(label) },
    { params: { projectId: project.id } },
  );
  response.status(201).body().exists('$.secret_key').exists('$.token_id');
  const body = response.json<{ secret_key: string; token_id: string }>();
  ctx.track('token', body.token_id);
  return ctx.client.withBearer(body.secret_key, 'PAT_PROJ');
}

flow('SKILL-1', {
  domain: 'skills',
  tags: ['smoke'],
  routes: ['GET /v1/skills', 'POST /v1/projects/:projectId/cli-token'],
}, async (ctx) => {
  const projectPat = await createProjectPat(ctx, 'skill-list-pat');
  await ctx.step('ANON cannot list the system skills', async () => {
    const r = await ctx.client.as(ctx.P.ANON).get('/v1/skills');
    r.status(401);
  });
  await ctx.step('a PROJECT-scoped PAT can list — this is the in-sandbox agent', async () => {
    // The `KORTIX_TOKEN` injected into every sandbox is a project+session
    // scoped PAT, and project-scoped tokens are default-DENIED on surfaces
    // outside /v1/projects/:id. That is the caller these routes exist for, so
    // it is the one that must be asserted here — an owner JWT passing proves
    // nothing about the sandbox.
    const r = await projectPat.get('/v1/skills');
    r.status(200);
  });
  await ctx.step('authed list → 200 with descriptions and no bodies', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/skills');
    r.status(200).body().exists('$.skills').exists('$.count');
    const body = r.json();
    const known = (body.skills ?? []).find((s: any) => s.name === KNOWN_SKILL);
    if (!known) throw new Error(`expected "${KNOWN_SKILL}" in the system skill list`);
    if (!known.description) throw new Error('list entries must carry a frontmatter description');
    if (known.body !== undefined) {
      throw new Error('the list must not carry skill bodies — it is the cheap surface');
    }
    if (body.count !== body.skills.length) throw new Error('count must match skills.length');
  });
});

flow(
  'SKILL-2',
  {
    domain: 'skills',
    tags: ['smoke'],
    routes: ['GET /v1/skills/:name', 'POST /v1/projects/:projectId/cli-token'],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'skill-read-pat');
    await ctx.step('ANON cannot read a skill body', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/skills/:name', {
        params: { name: KNOWN_SKILL },
      });
      r.status(401);
    });
    await ctx.step('authed get → 200 complete SKILL.md + reference paths', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name', { params: { name: KNOWN_SKILL } });
      r.status(200).body().has('$.name', KNOWN_SKILL).exists('$.body').exists('$.references');
      const body = r.json();
      if (!String(body.body).startsWith('---')) {
        throw new Error('body must be the full SKILL.md, frontmatter included');
      }
      for (const f of body.references ?? []) {
        if (f.content !== undefined) {
          throw new Error('reference contents must be opt-in (?full=1), not default');
        }
      }
    });
    await ctx.step('?full=1 inlines the reference files', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name', { params: { name: KNOWN_SKILL }, query: { full: '1' } });
      r.status(200);
      const refs = r.json().references ?? [];
      if (refs.length > 0 && typeof refs[0].content !== 'string') {
        throw new Error('?full=1 must inline reference contents');
      }
    });
    await ctx.step('a PROJECT-scoped PAT can read the body (the in-sandbox read)', async () => {
      const r = await projectPat.get('/v1/skills/:name', { params: { name: KNOWN_SKILL } });
      r.status(200).body().exists('$.body');
    });
    await ctx.step('a name that is not a managed skill → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name', { params: { name: 'not-a-kortix-skill' } });
      r.status(404);
    });
  },
);

flow(
  'SKILL-3',
  { domain: 'skills', routes: ['GET /v1/skills/:name/file'] },
  async (ctx) => {
    await ctx.step('ANON cannot read a reference file', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/skills/:name/file', {
        params: { name: KNOWN_SKILL },
        query: { path: 'references/capabilities.md' },
      });
      r.status(401);
    });
    await ctx.step('a listed reference path round-trips', async () => {
      const detail = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name', { params: { name: KNOWN_SKILL } });
      detail.status(200);
      const first = (detail.json().references ?? [])[0];
      if (!first) return; // no references on this deploy — nothing to round-trip
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name/file', {
          params: { name: KNOWN_SKILL },
          query: { path: first.path },
        });
      r.status(200).body().has('$.path', first.path).exists('$.content');
    });
    await ctx.step('missing path → 400, not 500', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/skills/:name/file', { params: { name: KNOWN_SKILL } });
      r.status(400);
    });
    await ctx.step('traversal attempt → 403/404, never a file outside the skill', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/skills/:name/file', {
        params: { name: KNOWN_SKILL },
        query: { path: '../../../../etc/passwd' },
      });
      r.status([403, 404]);
    });
  },
);

// PSKILL-1 — POST /v1/projects/:projectId/skills commits skills/<slug>/SKILL.md
// onto the default branch: the model-free form path behind Customize → Skills →
// New ("Create with a form"). The chat path needs a model — on a fresh free
// account it was a dead end ("requires a paid plan", no model to pick) — so
// this route must not need one. Maps to spec §26 (PSKILL-1).
// Mutating + git commit → serial.
flow(
  'PSKILL-1',
  {
    domain: 'skills',
    serial: true,
    routes: [
      'POST /v1/projects/:projectId/skills',
      'GET /v1/projects/:projectId/files/content',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('ANON cannot create a skill', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/:projectId/skills', { name: 'Anon Skill' }, { params: { projectId: p.id } });
      r.status(401);
    });

    await ctx.step('a non-member cannot create a skill', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/projects/:projectId/skills', { name: 'Outsider Skill' }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    const slug = 'release-notes';
    await ctx.step('create → 201 names the committed path', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/skills',
          { name: 'Release Notes', description: 'Draft the weekly "release notes": go' },
          { params: { projectId: p.id } },
        );
      r.status(201).body().has('$.ok', true).exists('$.slug').exists('$.path');
      const body = r.json<{ ok: boolean; slug: string; path: string }>();
      if (!body.slug.startsWith('release-notes')) {
        throw new Error(`slug must derive from the name, got "${body.slug}"`);
      }
      if (body.path !== `skills/${body.slug}/SKILL.md`) {
        throw new Error(`path must be skills/<slug>/SKILL.md, got "${body.path}"`);
      }
    });

    await ctx.step('a quoted description round-trips through the frontmatter reader', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId', {
        params: { projectId: p.id },
      });
      r.status(200);
      const config = r.json<any>().config;
      const skills = (config?.skills ?? []) as Array<{ name: string; path: string; description: string | null }>;
      const skill = skills.find((s) => s.path === `skills/${slug}/SKILL.md`);
      if (!skill) {
        throw new Error(`the created skill is missing from the catalog: ${JSON.stringify(skills.map((s) => s.path))}`);
      }
      if (skill.name !== 'Release Notes') throw new Error(`frontmatter name read back as "${skill.name}"`);
      if (skill.description !== 'Draft the weekly "release notes": go') {
        throw new Error(`frontmatter description read back as "${skill.description}"`);
      }
    });

    await ctx.step('the committed file reads back with frontmatter and body', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/files/content', {
        params: { projectId: p.id },
        query: { path: `skills/${slug}/SKILL.md` },
      });
      r.status(200);
      const content = r.json<any>().content as string;
      if (!content?.startsWith('---\n')) throw new Error('the committed skill must start with frontmatter');
      if (!/^name: "Release Notes"$/m.test(content)) {
        throw new Error(`frontmatter must quote the name, got:\n${content.split('\n').slice(0, 4).join('\n')}`);
      }
      if (!/# Release Notes/.test(content)) throw new Error('the body must start with the skill title');
    });

    await ctx.step('the same slug again → 409', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/skills', { name: 'Release Notes' }, { params: { projectId: p.id } });
      r.status(409);
    });

    await ctx.step('a blank name → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/skills', { name: '   ' }, { params: { projectId: p.id } });
      r.status(400);
    });
  },
);
