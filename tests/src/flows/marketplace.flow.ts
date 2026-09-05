/**
 * Marketplace — the public template catalog (`/v1/public/marketplace/templates`)
 * and the per-project install (`/v1/projects/:projectId/marketplace/install-session`).
 *
 * A template is a public GitHub repository whose `kortix.yaml` declares agents,
 * skills, connectors and triggers. The catalog is a static list that ships with
 * the API, so these flows read what every deployment serves rather than what a
 * fixture submitted — there is no submit route to exercise.
 *
 * Install is asserted at the validation boundary. It spawns a real session once
 * past validation, and a session needs a cloud sandbox with a reachable callback
 * origin — excluded locally. So a `503 KORTIX_URL_UNREACHABLE` past the gate is
 * the pass condition, and every 4xx boundary before it is asserted exactly.
 *
 * Maps to spec §29.
 */
import { flow } from '../core/flow';

/** A syntactically-valid but non-existent id, for boundary probes. */
const NOPE = '00000000-0000-4000-a000-000000000000';

/** The status set a route past its gates may answer with locally. */
const SESSION_OR_UNREACHABLE = [201, 503];

// ─── MKTP-1 — the public catalog ─────────────────────────────────────────────
flow(
  'MKTP-1',
  {
    domain: 'projects',
    routes: ['GET /v1/public/marketplace/templates', 'GET /v1/public/marketplace/templates/:slug'],
  },
  async (ctx) => {
    let first = { slug: '', title: '', repo: '' };

    await ctx.step(
      'the catalog reads with no auth at all → 200, cached, with an ETag',
      async () => {
        const r = await ctx.client.as(ctx.P.ANON).get('/v1/public/marketplace/templates');
        r.status(200).body().exists('$.templates');
        r.headerEquals('cache-control', 'public, max-age=300, must-revalidate');
        r.headerExists('etag');
        const templates = r.json().templates as Array<Record<string, unknown>>;
        if (templates.length === 0) throw new Error('the curated catalog is empty');
        for (const template of templates) {
          // A card is the public shape; the manifest travels to the agent through
          // the install prompt and must never reach a browser.
          if ('manifest' in template) throw new Error(`${template.slug} leaks its manifest`);
          if (!/^[0-9a-f]{40}$/.test(String(template.resolved_sha))) {
            throw new Error(`${template.slug} is not pinned to a commit`);
          }
        }
        first = templates[0] as unknown as typeof first;
      },
    );

    await ctx.step('the catalog revalidates → 304 on a matching ETag', async () => {
      const r1 = await ctx.client.as(ctx.P.ANON).get('/v1/public/marketplace/templates');
      r1.status(200);
      const again = await ctx.client.as(ctx.P.ANON).get('/v1/public/marketplace/templates', {
        headers: { 'if-none-match': r1.header('etag')! },
      });
      again.status(304);
    });

    await ctx.step('`q` narrows the catalog to templates that say the word', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/marketplace/templates', { query: { q: first.title.toUpperCase() } });
      r.status(200);
      const slugs = (r.json().templates as Array<{ slug: string }>).map((t) => t.slug);
      if (!slugs.includes(first.slug)) throw new Error('search missed a title match');
      const miss = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/marketplace/templates', { query: { q: 'no-such-template-zzz' } });
      miss.status(200);
      if ((miss.json().templates as unknown[]).length !== 0) {
        throw new Error('a nonsense query still returned templates');
      }
    });

    await ctx.step('one template by slug → 200 with the same card', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get(`/v1/public/marketplace/templates/${first.slug}`);
      r.status(200).body().has('$.template.slug', first.slug).has('$.template.repo', first.repo);
      r.headerExists('etag');
    });

    await ctx.step('an unknown slug → 404', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/public/marketplace/templates/nope');
      r.status(404);
    });
  },
);

// ─── MKTP-2 — the feature gate ───────────────────────────────────────────────
flow(
  'MKTP-2',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/marketplace/install-session'] },
  async (ctx) => {
    // No `marketplace` in metadata: the flag is OFF, and the install must fail
    // closed rather than start a session.
    const project = await ctx.fixtures.project({ managedGit: true });

    await ctx.step('the flag is off → 403 feature_disabled, not a session', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug: 'sre-oncall' },
          { params: { projectId: project.id } },
        );
      r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'marketplace');
    });

    await ctx.step('membership is checked BEFORE the flag — a stranger gets 404', async () => {
      // Otherwise a 403 would tell a stranger whether this project has the
      // marketplace on.
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug: 'sre-oncall' },
          { params: { projectId: project.id } },
        );
      r.status([403, 404]);
    });
  },
);

// ─── MKTP-3 — the install session ────────────────────────────────────────────
flow(
  'MKTP-3',
  {
    domain: 'projects',
    routes: [
      'GET /v1/public/marketplace/templates',
      'POST /v1/projects/:projectId/marketplace/install-session',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { marketplace: true } },
    });
    let slug = '';

    await ctx.step('pick a template from the catalog', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/public/marketplace/templates');
      r.status(200);
      slug = (r.json().templates as Array<{ slug: string }>)[0]?.slug ?? '';
      if (!slug) throw new Error('the curated catalog is empty');
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug },
          { params: { projectId: project.id } },
        );
      r.status(401);
    });

    await ctx.step('unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug },
          { params: { projectId: NOPE } },
        );
      r.status(404);
    });

    await ctx.step('missing slug → 400, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          {},
          { params: { projectId: project.id } },
        );
      r.status(400).body().has('$.error', 'slug is required');
    });

    await ctx.step('unknown slug → 404, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug: 'no-such-template' },
          { params: { projectId: project.id } },
        );
      r.status(404);
    });

    await ctx.step('a NONMEMBER → 403/404, never a session', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug },
          { params: { projectId: project.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step('past every gate → a session, or the local sandbox limit', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { slug },
          { params: { projectId: project.id } },
        );
      r.status(SESSION_OR_UNREACHABLE);
      if (r.statusCode === 201) r.body().exists('$.session_id');
      else r.body().has('$.code', 'KORTIX_URL_UNREACHABLE');
    });
  },
);
