/**
 * Platform-managed GitHub through Nango.
 *
 * These shared-environment checks prove the admin boundary and non-mutating
 * reads. Selection and disconnect happy paths run only in the dedicated live
 * Nango acceptance workflow because they change platform-wide state.
 */
import { flow } from '../core/flow';

flow(
  'GHA-1',
  {
    domain: 'platform',
    routes: [
      'POST /v1/platform/github-app/manifest-start',
      'POST /v1/platform/github-app/app',
      'POST /v1/platform/github-app/pat',
      'GET /v1/platform/github-app/manifest-callback',
      'GET /v1/platform/github-app/install-callback',
      'GET /v1/platform/github-app/status',
      'POST /v1/platform/github-app/connect-session',
      'GET /v1/platform/github-app/candidates',
    ],
  },
  async (ctx) => {
    await ctx.step('ANON cannot read managed GitHub status', async () => {
      const response = await ctx.client.as(ctx.P.ANON).get('/v1/platform/github-app/status');
      response.status(401);
    });
    await ctx.step('ANON cannot create a managed Nango Connect session', async () => {
      const response = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/platform/github-app/connect-session', {});
      response.status(401);
    });
    await ctx.step('ANON cannot list managed Nango candidates', async () => {
      const response = await ctx.client.as(ctx.P.ANON).get('/v1/platform/github-app/candidates');
      response.status(401);
    });
    for (const path of [
      '/v1/platform/github-app/manifest-start',
      '/v1/platform/github-app/app',
      '/v1/platform/github-app/pat',
    ]) {
      await ctx.step(`ANON cannot use deprecated managed setup route ${path}`, async () => {
        const response = await ctx.client.as(ctx.P.ANON).post(path, {});
        response.status(401);
      });
    }
    for (const path of [
      '/v1/platform/github-app/manifest-callback',
      '/v1/platform/github-app/install-callback',
    ]) {
      await ctx.step(`deprecated public callback returns Nango guidance from ${path}`, async () => {
        const response = await ctx.client.as(ctx.P.ANON).get(path);
        response
          .status(409)
          .body()
          .has('$.code', 'github_connection_required')
          .has('$.requires_human_oauth', true)
          .has('$.sdk_action', 'createManagedGitHubConnectSession');
      });
    }

    await ctx.step('non-admin OWNER cannot read managed GitHub status', async () => {
      const response = await ctx.client.as(ctx.P.OWNER).get('/v1/platform/github-app/status');
      response.status(403);
    });
    await ctx.step('non-admin OWNER cannot create a managed Connect session', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/platform/github-app/connect-session', {});
      response.status(403);
    });
    await ctx.step('non-admin OWNER cannot list managed candidates', async () => {
      const response = await ctx.client.as(ctx.P.OWNER).get('/v1/platform/github-app/candidates');
      response.status(403);
    });

    if (ctx.env.capabilities.admin) {
      const adminToken = ctx.env.adminToken;
      if (!adminToken) throw new Error('ADMIN_TOKEN is required when admin capability is enabled');
      const admin = ctx.client.withBearer(adminToken, 'ADMIN_TOKEN');
      await ctx.step('admin reads Nango-only managed GitHub status', async () => {
        const response = await admin.get('/v1/platform/github-app/status');
        response.status(200).body().exists('$.configured').exists('$.source');
        const source = response.json<{ source?: string }>()?.source;
        if (source !== 'nango' && source !== 'none') {
          throw new Error(`expected source nango or none, got: ${source}`);
        }
      });
      await ctx.step('admin lists Nango managed candidates', async () => {
        const response = await admin.get('/v1/platform/github-app/candidates');
        response.status(200).body().exists('$.candidates');
      });
    }
  },
);

flow(
  'GHA-2',
  {
    domain: 'platform',
    routes: [
      'DELETE /v1/platform/github-app',
      'POST /v1/platform/github-app/select',
      'POST /v1/platform/github-app/reconnect-session',
      'DELETE /v1/platform/github-app/connection',
    ],
  },
  async (ctx) => {
    await ctx.step('ANON cannot use the deprecated managed disconnect route', async () => {
      const response = await ctx.client.as(ctx.P.ANON).del('/v1/platform/github-app');
      response.status(401);
    });
    await ctx.step('ANON cannot select a managed Nango connection', async () => {
      const response = await ctx.client.as(ctx.P.ANON).post('/v1/platform/github-app/select', {});
      response.status(401);
    });
    await ctx.step('ANON cannot reconnect a managed Nango connection', async () => {
      const response = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/platform/github-app/reconnect-session', {});
      response.status(401);
    });
    await ctx.step('ANON cannot disconnect the managed Nango connection', async () => {
      const response = await ctx.client.as(ctx.P.ANON).del('/v1/platform/github-app/connection');
      response.status(401);
    });

    await ctx.step('non-admin OWNER cannot select a managed connection', async () => {
      const response = await ctx.client.as(ctx.P.OWNER).post('/v1/platform/github-app/select', {});
      response.status(403);
    });
    await ctx.step('non-admin OWNER cannot reconnect a managed connection', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/platform/github-app/reconnect-session', {});
      response.status(403);
    });
    await ctx.step('non-admin OWNER cannot disconnect the managed connection', async () => {
      const response = await ctx.client.as(ctx.P.OWNER).del('/v1/platform/github-app/connection');
      response.status(403);
    });

    if (ctx.env.capabilities.admin) {
      const adminToken = ctx.env.adminToken;
      if (!adminToken) throw new Error('ADMIN_TOKEN is required when admin capability is enabled');
      const admin = ctx.client.withBearer(adminToken, 'ADMIN_TOKEN');
      await ctx.step('admin select rejects a missing connection_id', async () => {
        const response = await admin.post('/v1/platform/github-app/select', {});
        response.status(400);
      });
      await ctx.step('admin reconnect rejects a missing connection_id', async () => {
        const response = await admin.post('/v1/platform/github-app/reconnect-session', {});
        response.status(400);
      });
    }
  },
);

flow(
  'GHA-3',
  {
    domain: 'platform',
    routes: ['POST /v1/webhooks/nango'],
  },
  async (ctx) => {
    await ctx.step('unsigned Nango webhook is rejected', async () => {
      const response = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/nango', {});
      response.status([401, 503]);
    });
  },
);
