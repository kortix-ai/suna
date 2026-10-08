/**
 * Router backlog. RTR-4's per-service proxy routes are `proxy.all(...)` (method
 * ALL), which no flow can declare, and calling one needs real provider keys,
 * which the local profile excludes. RTR-4 proves the router is mounted via the
 * public `GET /v1/router/health` and that a billed proxy refuses a caller with no
 * Kortix token (401) before any upstream call. It never sends a valid Kortix
 * token to a billed endpoint (that would make a real upstream call).
 */
import { flow } from '../core/flow';

// ─── PLT-1 — platform mount-point + sandbox version/changelog reads ───────
// apps/api/src/platform/index.ts mounts `platformApp` at /v1/platform with NO
// auth middleware of its own (app.route('/v1/platform', platformApp) in
// apps/api/src/index.ts:695) — the mount-point info handler and every
// versionRouter read (apps/api/src/platform/routes/version.ts) are public.
// version.ts falls back to `{version:'unknown'|'dev-unknown', ...}` when the
// upstream GitHub Releases / Docker Hub calls fail or SANDBOX_VERSION isn't
// set, so these always return 200 with a stable shape rather than erroring.
flow(
  'PLT-1',
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
    routes: ['GET /v1/router/health'],
  },
  async (ctx) => {
    await ctx.step('router is mounted: GET /router/health is public → 200', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/router/health');
      r.status(200).body().has('$.status', 'ok').has('$.service', 'kortix-router');
    });
    await ctx.step('billed proxy without a Kortix token → 401, no upstream call', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/router/tavily/search', { query: 'noop' });
      r.status(401);
    });
  },
);
