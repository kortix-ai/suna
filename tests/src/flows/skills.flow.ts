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
    '/v1/projects/:workspaceId/cli-token',
    { name: ctx.fixtures.name(label) },
    { params: { workspaceId: project.id } },
  );
  response.status(201).body().exists('$.secret_key').exists('$.token_id');
  const body = response.json<{ secret_key: string; token_id: string }>();
  ctx.track('token', body.token_id);
  return ctx.client.withBearer(body.secret_key, 'PAT_PROJ');
}

flow('SKILL-1', {
  domain: 'skills',
  tags: ['smoke'],
  routes: ['GET /v1/skills', 'POST /v1/projects/:workspaceId/cli-token'],
}, async (ctx) => {
  const projectPat = await createProjectPat(ctx, 'skill-list-pat');
  await ctx.step('ANON cannot list the system skills', async () => {
    const r = await ctx.client.as(ctx.P.ANON).get('/v1/skills');
    r.status(401);
  });
  await ctx.step('a PROJECT-scoped PAT can list — this is the in-sandbox agent', async () => {
    // The `KORTIX_CLI_TOKEN` injected into every sandbox is a project+session
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
    routes: ['GET /v1/skills/:name', 'POST /v1/projects/:workspaceId/cli-token'],
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
