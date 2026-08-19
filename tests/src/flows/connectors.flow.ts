/**
 * Connector catalog and connections — project connector admin, policies,
 * credentials, and the call gateway. Connectors are project-wide visible (no
 * per-connector sharing/agent-scope — retired 2026-07-06, see
 * spec/end-to-end.md §24). Maps to spec §24 (CONN-1..5, 7-9, 12-14).
 */
import { flow } from '../core/flow';

flow(
  'CONN-1',
  {
    domain: 'connectors',
    tags: ['smoke'],
    routes: ['GET /v1/connectors/catalog', 'GET /v1/connectors/connectors'],
  },
  async (ctx) => {
    // The catalog + /call are connector-principal routes (the sandbox runtime calls
    // them with a project/sandbox KORTIX_TOKEN). A bare user JWT is NOT a connector
    // principal → 401; ANON → 401. The 200 path is exercised by the in-sandbox
    // connector (covered by sandbox/agent-run flows), not a dashboard JWT.
    await ctx.step('user JWT is not a connector principal → 401', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/catalog');
      r.status(401);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/connectors/catalog');
      r.status(401);
    });
    await ctx.step('legacy catalog alias preserves connector-principal auth → 401', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/connectors');
      r.status(401);
    });
  },
);

flow(
  'CONN-2',
  { domain: 'connectors', routes: ['GET /v1/connectors/projects/:projectId/connectors'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('project admin lists connectors', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors', { params: { projectId: p.id } });
      r.status(200);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/connectors', { params: { projectId: p.id } });
      r.status(403);
    });
  },
);

flow(
  'CONN-19',
  {
    domain: 'connectors',
    routes: ['PUT /v1/connectors/projects/:projectId/connectors/:slug/secret-binding'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('malformed identifier is rejected before connector lookup', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/secret-binding',
          { secret_identifier: 'contains whitespace' },
          { params: { projectId: p.id, slug: 'missing' } },
        );
      r.status(400);
    });
    await ctx.step('unknown connector is not found', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/secret-binding',
          { secret_identifier: 'API_KEY' },
          { params: { projectId: p.id, slug: 'missing' } },
        );
      r.status(404);
    });
    await ctx.step('NONMEMBER is rejected', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/secret-binding',
          { secret_identifier: null },
          { params: { projectId: p.id, slug: 'missing' } },
        );
      r.status(403);
    });
  },
);

flow('CONN-3', { domain: 'connectors', routes: ['POST /v1/connectors/call'] }, async (ctx) => {
  // /call is connector-principal only: a user JWT and ANON both → 401 (the real
  // caller is the sandbox runtime with KORTIX_TOKEN).
  await ctx.step('user JWT → 401', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/connectors/call', {});
    r.status(401);
  });
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post('/v1/connectors/call', { connector: 'x', action: 'y' });
    r.status(401);
  });
});

flow(
  'CONN-4',
  { domain: 'connectors', routes: ['POST /v1/connectors/projects/:projectId/connectors/sync'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('sync re-materializes from kortix.yaml → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/connectors/sync',
          {},
          { params: { projectId: p.id } },
        );
      r.status(200);
    });
  },
);

flow(
  'CONN-5',
  {
    domain: 'connectors',
    // This flow mutates kortix.yaml. Run it after the parallel lanes so it can
    // reuse the shared managed repository without racing read-only flows.
    global: true,
    routes: [
      'GET /v1/connectors/projects/:projectId/policies',
      'PUT /v1/connectors/projects/:projectId/policies',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('read policies → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/policies', { params: { projectId: p.id } });
      r.status([200, 501]);
    });
    await ctx.step('replace policies → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/policies',
          { policies: [] },
          { params: { projectId: p.id } },
        );
      r.status([200, 501]);
    });
  },
);

flow(
  'CONN-7',
  {
    domain: 'connectors',
    routes: ['PUT /v1/connectors/projects/:projectId/connectors/:slug/credential'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing value → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/credential',
          {},
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step('unsafe OAuth2 token URL → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(
        '/v1/connectors/projects/:projectId/connectors/:slug/credential',
        {
          oauth2: {
            type: 'oauth2_client_credentials',
            token_url: 'http://127.0.0.1/token',
            client_id: 'client-id',
            token_endpoint_auth_method: 'client_secret_post',
            client_secret: 'client-secret',
          },
        },
        { params: { projectId: p.id, slug: 'nope' } },
      );
      r.status(400);
    });
  },
);

flow(
  'CONN-8',
  {
    domain: 'connectors',
    requires: ['managedGit'],
    routes: [
      'POST /v1/connectors/projects/:projectId/connectors',
      'DELETE /v1/connectors/projects/:projectId/connectors/:slug',
      'GET /v1/connectors/projects/:projectId/connectors/:slug/config',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const slug = `ke2e-create-only-${Date.now().toString(36)}`;
    await ctx.step('invalid json add → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/connectors/projects/:projectId/connectors', 'not json', {
          params: { projectId: p.id },
          raw: true,
          headers: { 'content-type': 'application/json' },
        });
      r.status(400);
    });
    await ctx.step('non-boolean create-only flag → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug,
          provider: 'mcp',
          url: 'https://ke2e.kortix.test/mcp',
          auth: { type: 'none' },
          create_only: 'true',
        },
        { params: { projectId: p.id } },
      );
      r.status(400).body().has('$.error', 'create_only must be a boolean');
    });
    await ctx.step('first create-only connector succeeds', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug,
          name: 'Original connector',
          provider: 'mcp',
          url: 'https://ke2e.kortix.test/mcp',
          auth: { type: 'none' },
          create_only: true,
        },
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('duplicate create-only connector → 409', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug,
          name: 'Replacement connector',
          provider: 'mcp',
          url: 'https://ke2e.kortix.test/mcp',
          auth: { type: 'none' },
          create_only: true,
        },
        { params: { projectId: p.id } },
      );
      r.status(409);
    });
    await ctx.step('duplicate request leaves the original manifest entry unchanged', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
          params: { projectId: p.id, slug },
        });
      r.status(200).body().has('$.name', 'Original connector');
    });
    await ctx.step('delete the created connector → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/connectors/projects/:projectId/connectors/:slug', {
          params: { projectId: p.id, slug },
        });
      r.status(200);
    });
  },
);

flow(
  'CONN-9',
  {
    domain: 'connectors',
    routes: [
      'GET /v1/connectors/projects/:projectId/pipedream/apps',
      'GET /v1/connectors/projects/:projectId/pipedream/sections',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('pipedream catalog → 200 or 501', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/pipedream/apps', { params: { projectId: p.id } });
      r.status([200, 501]);
    });
    await ctx.step('pipedream category sections are bounded and stable → 200 or 501', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/pipedream/sections', {
          params: { projectId: p.id },
          query: { perCategory: '4', maxCategories: '6' },
        });
      r.status([200, 501]);
      if (r.statusCode === 200) {
        r.body().exists('$.sections').exists('$.categories').exists('$.indexReady');
      }
    });
    await ctx.step('NONMEMBER cannot read pipedream category sections → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/pipedream/sections', {
          params: { projectId: p.id },
        });
      r.status(403);
    });
  },
);

flow(
  'CONN-15',
  {
    domain: 'connectors',
    serial: true,
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/connectors/projects/:projectId/discover/connectors',
      'GET /v1/connectors/projects/:projectId/discover/connectors/detail',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('project admin enables direct catalogue discovery', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/features',
        { feature: 'connectors_api_discover', enabled: true },
        { params: { projectId: p.id } },
      );
      r.status(200);
    });
    await ctx.step('project admin browses the direct catalogue', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/discover/connectors', {
          params: { projectId: p.id },
          query: { q: 'HubSpot' },
        });
      r.status([200, 502]);
      if (r.statusCode !== 200) return;
      r.body().exists('$.items').exists('$.total').exists('$.hasMore');
      const firstId = r.json<{ items?: Array<{ id?: string }> }>().items?.[0]?.id;
      if (!firstId) return;
      const detail = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/discover/connectors/detail', {
          params: { projectId: p.id },
          query: { id: firstId },
        });
      detail.status(200).body().exists('$.item').exists('$.variants');
    });
    await ctx.step('NONMEMBER cannot browse or resolve catalogue records', async () => {
      const list = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/discover/connectors', {
          params: { projectId: p.id },
        });
      list.status(403);
      const detail = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/discover/connectors/detail', {
          params: { projectId: p.id },
          query: { id: 'openapi/example' },
        });
      detail.status(403);
    });
  },
);

flow(
  'CONN-12',
  {
    domain: 'connectors',
    routes: ['GET /v1/connectors/projects/:projectId/connectors/:slug/config'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status([404, 501]);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status(403);
    });
  },
);

// Admin: connector-connection mutations — credential mode, authorization strategy,
// display name, and per-tool/per-pattern policies. All four gate on project.connector.write
// (resolveAdmin), validate their body BEFORE looking up the connector (so an
// invalid mode/name/policy is a 400 even against an unknown slug), and 404 an
// unknown connector once the body is well-formed.
flow(
  'CONN-13',
  {
    domain: 'connectors',
    routes: [
      'PUT /v1/connectors/projects/:projectId/connectors/:slug/credential-mode',
      'PUT /v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
      'PUT /v1/connectors/projects/:projectId/connectors/:slug/name',
      'PUT /v1/connectors/projects/:projectId/connectors/:slug/policies',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('credential-mode: invalid mode → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/credential-mode',
          { mode: 'nope' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step('credential-mode: valid mode but unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/credential-mode',
          { mode: 'shared' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(404);
    });

    await ctx.step('authorization strategy: unsupported value → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
          { authorization_strategy: 'both' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step('authorization strategy: valid value but unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
          { authorization_strategy: 'user' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(404);
    });

    await ctx.step('name: empty name → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/name',
          { name: '' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step('name: valid name but unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/name',
          { name: 'Renamed' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(404);
    });

    await ctx.step('policies: not an array → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/policies',
          { policies: 'nope' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step(
      'policies: invalid action validated before the connector lookup → 400',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(
            '/v1/connectors/projects/:projectId/connectors/:slug/policies',
            { policies: [{ match: 'foo', action: 'nope' }] },
            { params: { projectId: p.id, slug: 'nope' } },
          );
        r.status(400);
      },
    );
    await ctx.step('policies: well-formed but unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/policies',
          { policies: [] },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(404);
    });

    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/credential-mode',
          { mode: 'shared' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      r.status(403);
    });
  },
);

flow(
  'CONN-14',
  {
    domain: 'connectors',
    routes: ['POST /v1/connectors/projects/:projectId/connectors/auth-discovery'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('source with no location returns an empty discovery', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/connectors/auth-discovery',
          { provider: 'openapi' },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has('$.status', 'none')
        .has('$.recommended', null)
        .has('$.totalRequests', 0);
    });

    await ctx.step('NONMEMBER cannot inspect connector authentication', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/connectors/projects/:projectId/connectors/auth-discovery',
          { provider: 'openapi' },
          { params: { projectId: p.id } },
        );
      r.status(403);
    });
  },
);

// Pairs with CONN-7 (PUT .../credential) — disconnect (delete) a connector's
// stored credential. Unknown connector → 404 (deleteConnectorCredential looks
// the connector up before touching the credential store).
flow(
  'CONN-16',
  {
    domain: 'connectors',
    routes: ['DELETE /v1/connectors/projects/:projectId/connectors/:slug/credential'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('delete credential for an unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/connectors/projects/:projectId/connectors/:slug/credential', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del('/v1/connectors/projects/:projectId/connectors/:slug/credential', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status(403);
    });
  },
);

// Pairs with CONN-13 (PUT .../policies) — read a connector's per-tool/per-pattern
// policies. Unknown connector → 404 (manifest-first, DB-fallback; neither hits).
flow(
  'CONN-17',
  {
    domain: 'connectors',
    routes: ['GET /v1/connectors/projects/:projectId/connectors/:slug/policies'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('read policies for an unknown connector → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/policies', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/policies', {
          params: { projectId: p.id, slug: 'nope' },
        });
      r.status(403);
    });
  },
);

// Connections — mint→activate→credential→revoke lifecycle. A real connection
// needs an existing connector to reference by
// connector_alias, so this first declares a lightweight `mcp` connector (only
// requires a `url`, no live reachability check during manifest sync) via the
// already-covered POST /v1/connectors/projects/:projectId/connectors, then drives
// the full connections surface against it.
flow(
  'CONN-21',
  {
    domain: 'connectors',
    routes: [
      'GET /v1/projects/:projectId/connections',
      'POST /v1/projects/:projectId/connections',
      'PUT /v1/projects/:projectId/connections/:connectionId/activate',
      'POST /v1/projects/:projectId/connections/:connectionId/connect',
      'POST /v1/projects/:projectId/connections/:connectionId/connect/finalize',
      'PUT /v1/projects/:projectId/connections/:connectionId/credential',
      'PUT /v1/projects/:projectId/connections/:connectionId/revoke',
      'POST /v1/projects/:projectId/connections/me',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const slug = `ke2e-mcp-${Date.now().toString(36)}`;

    await ctx.step('seed a real connector for the connection (mcp provider)', async () => {
      // auth explicitly set (not omitted) so the create route skips its
      // auto-discovery probe — that probe does a LIVE fetch against the
      // connector's url, and this url is intentionally unreachable.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/connectors',
          { slug, provider: 'mcp', url: 'https://ke2e.kortix.test/mcp', auth: { type: 'none' } },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.ok', true);
    });

    await ctx.step('list connections → 200, empty before any connection exists', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/connections', { params: { projectId: p.id } });
      r.status(200).body().exists('$.connections');
    });

    await ctx.step('NONMEMBER cannot list → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/connections', { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/connections', { params: { projectId: p.id } });
      r.status(401);
    });

    let connectionId = '';
    await ctx.step('create (reconcile) a connection → 201 with a real shape', async () => {
      // Connectors default to the 'project' authorization strategy (#74a804d14);
      // any other owner_type on this route now 409s with
      // CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections',
          {
            connector_alias: slug,
            owner_type: 'project',
            label: 'KE2E connection',
          },
          { params: { projectId: p.id } },
        );
      r.status(201)
        .body()
        .has('$.connector_alias', slug)
        .has('$.owner_type', 'project')
        .has('$.status', 'active')
        .exists('$.connection_id');
      connectionId = r.json<any>().connection_id;
    });

    await ctx.step('missing required fields → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections',
          { connector_alias: slug },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    // /me reconciles a caller-owned member connection, which the strategy gate
    // only allows on a 'user'-strategy connector — seed a second connector and
    // flip it before reconciling.
    const userSlug = `${slug}-user`;
    let memberConnectionId = '';
    await ctx.step('reconcile the caller-owned member connection → 201', async () => {
      const seeded = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/connectors',
          { slug: userSlug, provider: 'mcp', url: 'https://ke2e.kortix.test/mcp', auth: { type: 'none' } },
          { params: { projectId: p.id } },
        );
      seeded.status(200).body().has('$.ok', true);
      // The strategy route re-reads the manifest from the repo; the connector
      // create's commit is not always visible immediately (manifest push
      // races), so retry the 404 briefly instead of failing on read lag.
      let flipped = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
          { authorization_strategy: 'user' },
          { params: { projectId: p.id, slug: userSlug } },
        );
      for (let attempt = 0; attempt < 5 && flipped.statusCode === 404; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        flipped = await ctx.client
          .as(ctx.P.OWNER)
          .put(
            '/v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
            { authorization_strategy: 'user' },
            { params: { projectId: p.id, slug: userSlug } },
          );
      }
      flipped.status(200).body().has('$.ok', true);
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections/me',
          { connector_alias: userSlug, label: 'KE2E member connection' },
          { params: { projectId: p.id } },
        );
      r.status(201)
        .body()
        .has('$.connector_alias', userSlug)
        .has('$.owner_type', 'member')
        .has('$.is_default', false)
        .exists('$.owner_id')
        .exists('$.connection_id');
      memberConnectionId = r.json<any>().connection_id;
    });

    await ctx.step('connection OAuth routes reject a non-Pipedream connector → 404/501', async () => {
      const connect = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections/:connectionId/connect',
          {},
          { params: { projectId: p.id, connectionId: memberConnectionId } },
        );
      connect.status([404, 501]);

      const finalize = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections/:connectionId/connect/finalize',
          {},
          { params: { projectId: p.id, connectionId: memberConnectionId } },
        );
      finalize.status([404, 501]);
    });

    await ctx.step('activate the connection → 200 ok', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/connections/:connectionId/activate',
          {},
          { params: { projectId: p.id, connectionId } },
        );
      r.status(200).body().has('$.ok', true);
    });

    await ctx.step("set the connection's credential → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/connections/:connectionId/credential',
          { value: 'ke2e-secret-value' },
          { params: { projectId: p.id, connectionId } },
        );
      r.status(200).body().has('$.ok', true);
    });

    await ctx.step('credential with no value → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/connections/:connectionId/credential',
          {},
          { params: { projectId: p.id, connectionId } },
        );
      r.status(400);
    });

    await ctx.step(
      'revoke the connection (terminal state — no DELETE route exists) → 200 ok',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(
            '/v1/projects/:projectId/connections/:connectionId/revoke',
            {},
            { params: { projectId: p.id, connectionId } },
          );
        r.status(200).body().has('$.ok', true);
      },
    );

    await ctx.step('activate/credential/revoke on an unknown connectionId → 404', async () => {
      const unknown = '00000000-0000-4000-a000-000000000000';
      for (const op of ['activate', 'credential', 'revoke'] as const) {
        const body = op === 'credential' ? { value: 'x' } : {};
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(`/v1/projects/:projectId/connections/:connectionId/${op}`, body, {
            params: { projectId: p.id, connectionId: unknown },
          });
        r.status(404);
      }
    });
  },
);

flow(
  'CONN-OAUTH2',
  {
    domain: 'connectors',
    routes: [
      'POST /v1/projects/:projectId/connectors/:slug/oauth2/connection',
      'PUT /v1/projects/:projectId/connections/:connectionId/oauth2/application',
      'GET /v1/projects/:projectId/connections/:connectionId/oauth2/application',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/discover',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/discover-resource',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/register',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/authorize',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/device',
      'POST /v1/projects/:projectId/connections/:connectionId/oauth2/device/:sessionId',
      'GET /v1/projects/:projectId/connections/:connectionId/oauth2/status',
      'GET /v1/connectors/oauth2/callback',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const slug = `ke2e-oauth2-${Date.now().toString(36)}`;
    const connector = await ctx.client.as(ctx.P.OWNER).post(
      '/v1/connectors/projects/:projectId/connectors',
      {
        slug,
        provider: 'mcp',
        url: 'https://ke2e.kortix.test/mcp',
        auth: { type: 'none' },
      },
      { params: { projectId: p.id } },
    );
    connector.status(200);
    const defaultConnection = await ctx.client.as(ctx.P.OWNER).post(
      '/v1/projects/:projectId/connectors/:slug/oauth2/connection',
      {},
      { params: { projectId: p.id, slug } },
    );
    defaultConnection.status(200).body().exists('$.connection_id');
    // 'project' owner_type: connectors default to the project authorization
    // strategy, and any other owner_type now 409s on this route (#74a804d14).
    const created = await ctx.client.as(ctx.P.OWNER).post(
      '/v1/projects/:projectId/connections',
      {
        connector_alias: slug,
        owner_type: 'project',
        label: 'KE2E OAuth2',
      },
      { params: { projectId: p.id } },
    );
    created.status(201);
    const connectionId = created.json<any>().connection_id;

    await ctx.step('save and read a redacted generic OAuth2 application', async () => {
      const saved = await ctx.client.as(ctx.P.OWNER).put(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/application',
        {
          authorization_url: 'https://identity.example.com/authorize',
          token_url: 'https://identity.example.com/token',
          client_id: 'ke2e-public-client',
          token_endpoint_auth_method: 'none',
          scopes: ['read'],
        },
        { params: { projectId: p.id, connectionId } },
      );
      saved.status(200).body().has('$.ok', true);
      const read = await ctx.client.as(ctx.P.OWNER).get(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/application',
        { params: { projectId: p.id, connectionId } },
      );
      read
        .status(200)
        .body()
        .has('$.application.client_id', 'ke2e-public-client')
        .has('$.application.has_client_secret', false);
    });

    await ctx.step('start Authorization Code with PKCE and read ready status', async () => {
      const started = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/authorize',
        {},
        { params: { projectId: p.id, connectionId } },
      );
      started
        .status(200)
        .body()
        .exists('$.authorization_url')
        .exists('$.expires_at');
      const status = await ctx.client.as(ctx.P.OWNER).get(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/status',
        { params: { projectId: p.id, connectionId } },
      );
      status.status(200).body().has('$.status', 'ready');
    });

    await ctx.step('reject SSRF discovery and unavailable device endpoints', async () => {
      const discovery = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/discover',
        { discovery_url: 'https://127.0.0.1/.well-known/oauth-authorization-server' },
        { params: { projectId: p.id, connectionId } },
      );
      discovery.status(400);
      const device = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/device',
        {},
        { params: { projectId: p.id, connectionId } },
      );
      device.status(400);
      const poll = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/device/:sessionId',
        {},
        {
          params: {
            projectId: p.id,
            connectionId,
            sessionId: '00000000-0000-4000-8000-000000000000',
          },
        },
      );
      poll.status(400);
    });

    await ctx.step(
      'MCP authorization discovery and dynamic registration refuse unsafe endpoints',
      async () => {
        // The connector's own URL is unresolvable in the local profile; the
        // chain reports that as a 400 with a reason instead of hanging.
        const ownResource = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/discover-resource',
          {},
          { params: { projectId: p.id, connectionId } },
        );
        ownResource.status(400).body().exists('$.error');
        const loopbackResource = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/discover-resource',
          { resource_url: 'https://127.0.0.1/mcp' },
          { params: { projectId: p.id, connectionId } },
        );
        loopbackResource.status(400);
        const loopbackRegistration = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/register',
          {
            registration_endpoint: 'https://127.0.0.1/oauth/register',
            token_url: 'https://identity.example.com/token',
          },
          { params: { projectId: p.id, connectionId } },
        );
        loopbackRegistration.status(400);
        const incompleteRegistration = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/register',
          { registration_endpoint: 'https://identity.example.com/register' },
          { params: { projectId: p.id, connectionId } },
        );
        incompleteRegistration.status(400);
        // A non-member is stopped by the project gate before the connection
        // is ever looked up, so this is 403 — the same code every other
        // NONMEMBER step in this flow asserts — not the handler's 404.
        const foreign = await ctx.client.as(ctx.P.NONMEMBER).post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/discover-resource',
          {},
          { params: { projectId: p.id, connectionId } },
        );
        foreign.status(403);
      },
    );

    await ctx.step('reject an invalid public callback state', async () => {
      const callback = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/connectors/oauth2/callback?state=invalid&code=invalid');
      callback.status(400);
    });
  },
);

// Setup-links (connector half) — public, token-gated read + start + finalize.
// The minting side (POST /v1/projects/:projectId/connect-requests) belongs to a
// different coverage group; this covers the three public consume-side routes
// independently via the boundary case (a bogus token can never resolve,
// regardless of who eventually mints real ones), which is legitimate coverage
// on its own. `finalize` is the authoritative persist-and-notify call the
// hosted connect page's opener polls; the Pipedream webhook is redundancy.
flow(
  'CONN-22',
  {
    domain: 'connectors',
    routes: [
      'GET /v1/setup-links/connectors/:token',
      'POST /v1/setup-links/connectors/:token/start',
      'POST /v1/setup-links/connectors/:token/finalize',
    ],
  },
  async (ctx) => {
    await ctx.step('GET with a bogus token → 404 (invalid/unknown link)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/setup-links/connectors/:token', {
          params: { token: 'bogus-connector-setup-link' },
        });
      r.status(404).body().exists('$.error');
    });
    await ctx.step('POST .../start with a bogus token → 404 (invalid/unknown link)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/setup-links/connectors/:token/start',
          {},
          { params: { token: 'bogus-connector-setup-link' } },
        );
      r.status(404).body().exists('$.error');
    });
    await ctx.step('POST .../finalize with a bogus token → 404 (invalid/unknown link)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/setup-links/connectors/:token/finalize',
          {},
          { params: { token: 'bogus-connector-setup-link' } },
        );
      r.status(404).body().exists('$.error');
    });
  },
);

// CONN-18 — mint a Pipedream Quick Connect setup link (projects/routes/setup-links.ts).
// The real 200 needs a live Pipedream-backed connector already declared in
// kortix.yaml (which a bare e2e project has none of), so this covers the real
// validation boundary: missing slug → 400; a slug that names no connected-via-
// Pipedream connector on this project → 404 (or 501 if Pipedream isn't
// configured on this deployment at all — both are legitimate real outcomes,
// never a 200/201 without a real connector). The analogous public consume
// routes (`GET/POST /v1/setup-links/connectors/:token[/start]`, CONN-22 above)
// belong to a different coverage group.
flow(
  'CONN-18',
  { domain: 'connectors', routes: ['POST /v1/projects/:projectId/connect-requests'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing slug → 400, or 501 when Pipedream is disabled", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/connect-requests', {}, { params: { projectId: p.id } });
      r.status([400, 501]);
    });
    await ctx.step("unconnected slug → 404 (or 501 if Pipedream isn't configured)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connect-requests',
          { slug: 'not-a-connected-app' },
          { params: { projectId: p.id } },
        );
      r.status([404, 501]);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/connect-requests',
          { slug: 'not-a-connected-app' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);
