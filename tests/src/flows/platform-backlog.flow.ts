/**
 * Router backlog. RTR-4's per-service proxy routes are
 *    registered via `proxy.all(...)` (method ALL), which the route dumper skips,
 *    so neither `ALL /v1/router/:service` nor the concrete `/tavily/*` mounts
 *    appear in the manifest. We exercise the router's auth/disallowed boundary
 *    via the manifest-present `POST /v1/router/web-search` (apiKeyAuth: no/garbage
 *    token → 401) and prove the router is mounted via the public
 *    `GET /v1/router/health`. We deliberately never send a valid Kortix token to
 *    a billed endpoint (that would make a real upstream call).
 */
import { flow } from '../core/flow';

// ─── PLAT-1 — platform mount-point + sandbox version/changelog reads ──────
// apps/api/src/platform/index.ts mounts `platformApp` at /v1/platform with NO
// auth middleware of its own (app.route('/v1/platform', platformApp) in
// apps/api/src/index.ts:695) — the mount-point info handler and every
// versionRouter read (apps/api/src/platform/routes/version.ts) are public.
// version.ts falls back to `{version:'unknown'|'dev-unknown', ...}` when the
// upstream GitHub Releases / Docker Hub calls fail or SANDBOX_VERSION isn't
// set, so these always return 200 with a stable shape rather than erroring.
flow(
  'PLAT-1',
  {
    domain: 'platform',
    routes: [
      'GET /v1/platform',
      'GET /v1/platform/sandbox/version',
      'GET /v1/platform/sandbox/version/all',
      'GET /v1/platform/sandbox/version/changelog',
      'GET /v1/platform/sandbox/version/latest',
    ],
  },
  async (ctx) => {
    await ctx.step('platform mount-point info is public', async () => {
      const r = await ctx.client.get('/v1/platform');
      r.status(200).body().has('$.ok', true).has('$.message', 'platform');
    });
    await ctx.step('running sandbox version + channel', async () => {
      const r = await ctx.client.get('/v1/platform/sandbox/version');
      r.status(200).body().exists('$.version').exists('$.channel');
    });
    await ctx.step('all known sandbox versions plus the current running one', async () => {
      const r = await ctx.client.get('/v1/platform/sandbox/version/all');
      r.status(200).body().exists('$.versions').exists('$.current.version').exists('$.current.channel');
      const versions = r.json<{ versions?: unknown[] }>().versions;
      if (!Array.isArray(versions)) throw new Error('expected versions to be an array');
    });
    await ctx.step('sandbox changelog (default: all channels)', async () => {
      const r = await ctx.client.get('/v1/platform/sandbox/version/changelog');
      r.status(200).body().exists('$.changelog');
      const changelog = r.json<{ changelog?: unknown[] }>().changelog;
      if (!Array.isArray(changelog)) throw new Error('expected changelog to be an array');
    });
    await ctx.step('latest sandbox version defaults to the stable channel', async () => {
      const r = await ctx.client.get('/v1/platform/sandbox/version/latest');
      r.status(200).body().exists('$.version').has('$.channel', 'stable');
    });
    await ctx.step('latest sandbox version accepts an explicit dev channel', async () => {
      const r = await ctx.client.get('/v1/platform/sandbox/version/latest', {
        query: { channel: 'dev' },
      });
      r.status(200).body().exists('$.version').has('$.channel', 'dev');
    });
  },
);

// ─── RTR-4 — billed router passthrough (auth / disallowed boundary) ───────
flow(
  'RTR-4',
  {
    domain: 'accounts',
    routes: ['GET /v1/router/health', 'POST /v1/router/web-search'],
  },
  async (ctx) => {
    await ctx.step('router is mounted: GET /router/health is public → 200', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/router/health');
      r.status(200).body().has('$.status', 'ok').has('$.service', 'kortix-router');
    });
    await ctx.step('billed endpoint without any token → 401 (apiKeyAuth)', async () => {
      // No Authorization header at all — apiKeyAuth rejects before any upstream call.
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/router/web-search', { query: 'noop' });
      r.status(401);
    });
    await ctx.step(
      'billed endpoint with a non-kortix bearer → 401 (bad token format)',
      async () => {
        // A garbage bearer that isn't a kortix_ token — rejected on format, never billed.
        const r = await ctx.client
          .withBearer('definitely-not-a-kortix-token', 'BOGUS')
          .post('/v1/router/web-search', { query: 'noop' });
        r.status([401, 403]);
      },
    );
  },
);
