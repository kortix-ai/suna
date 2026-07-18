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
