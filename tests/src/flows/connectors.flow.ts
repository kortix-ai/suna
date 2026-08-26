/**
 * Connector catalog and connections — project connector admin, policies,
 * credentials, and the call gateway. Connectors are project-wide visible (no
 * per-connector sharing/agent-scope — retired 2026-07-06, see
 * spec/end-to-end.md §24). Maps to spec §24 (CONN-1..5, 7-9, 12-14).
 */
import { flow } from '../core/flow';
import { type CliResult, CliSandbox, throwIfCliInfraFailure } from '../fixtures/cli';

function parseCliJson<T>(result: CliResult, action: string): T {
  throwIfCliInfraFailure(result, action);
  if (result.exitCode !== 0) {
    throw new Error(`${action} exited ${result.exitCode}: ${result.all}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${action} returned invalid JSON: ${result.stdout}\n${result.stderr}`);
  }
}

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
  {
    domain: 'connectors',
    routes: ['GET /v1/connectors/projects/:projectId/connectors'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('project admin lists connectors', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors', {
          params: { projectId: p.id },
        });
      r.status(200);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/connectors', {
          params: { projectId: p.id },
        });
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
  {
    domain: 'connectors',
    routes: ['POST /v1/connectors/projects/:projectId/connectors/sync'],
  },
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
        .get('/v1/connectors/projects/:projectId/policies', {
          params: { projectId: p.id },
        });
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
      // BOTH outcomes are correct here, and the test must not pick only one.
      // This POST is a Git commit round-trip against the project manifest — the
      // slowest write in the flow — and the ke2e HTTP client retries any
      // request, POST included, on a fetch throw, a timeout, or an edge
      // 502/503/504 (core/client.ts) with no test-side idempotency guard. When
      // the first delivery lands but its response is lost, the retry finds the
      // slug already in the manifest and `create_only: true` refuses to replace
      // it with 409 (apps/api/src/connectors/manifest-crud.ts:250-257). That is
      // the create-only contract working, not a failure. The 200 path still
      // proves `$.ok`, and the config read below proves the entry landed
      // exactly once either way.
      r.status([200, 409]);
      if (r.statusCode === 200) r.body().has('$.ok', true);
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
        .get('/v1/connectors/projects/:projectId/pipedream/apps', {
          params: { projectId: p.id },
        });
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
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
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
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug,
          provider: 'mcp',
          url: 'https://ke2e.kortix.test/mcp',
          auth: { type: 'none' },
        },
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.ok', true);
    });

    await ctx.step('list connections → 200, empty before any connection exists', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/connections', {
        params: { projectId: p.id },
      });
      r.status(200).body().exists('$.connections');
    });

    await ctx.step('NONMEMBER cannot list → 403/404', async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).get('/v1/projects/:projectId/connections', {
        params: { projectId: p.id },
      });
      r.status([403, 404]);
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/connections', {
        params: { projectId: p.id },
      });
      r.status(401);
    });

    let connectionId = '';
    await ctx.step('create (reconcile) a connection → 201 with a real shape', async () => {
      // Connectors default to the 'project' authorization strategy (#74a804d14);
      // any other owner_type on this route now 409s with
      // CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH.
      const r = await ctx.client.as(ctx.P.OWNER).post(
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
      const seeded = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug: userSlug,
          provider: 'mcp',
          url: 'https://ke2e.kortix.test/mcp',
          auth: { type: 'none' },
        },
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

    await ctx.step(
      'connection OAuth routes reject a non-Pipedream connector → 404/501',
      async () => {
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
      },
    );

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
  'CONN-24',
  {
    domain: 'connectors',
    serial: true,
    timeoutMs: 240_000,
    routes: [
      'GET /v1/connectors/connect-status',
      'GET /v1/connectors/projects/:projectId/connect/toolkits',
      'POST /v1/connectors/projects/:projectId/connectors',
      'GET /v1/connectors/projects/:projectId/connectors/:slug/config',
      'POST /v1/connectors/projects/:projectId/connectors/:slug/connect',
      'POST /v1/connectors/projects/:projectId/connectors/:slug/connect/finalize',
      'GET /v1/connectors/projects/:projectId/sessions/:sessionId/connect-requests',
      'GET /v1/connectors/projects/:projectId/catalog',
      'POST /v1/connectors/projects/:projectId/call',
      'POST /v1/accounts/:accountId/audit/reconcile',
      'GET /v1/projects/:projectId/audit',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const p = await team.project({ managedGit: true });
    const cliPat = await ctx.fixtures.pat({
      name: ctx.fixtures.name('composio-cli'),
    });
    const slug = `ke2e-composio-${Date.now().toString(36)}`;
    const otherSlug = `${slug}-other`;
    const rejectedLegacySlug = `${slug}-legacy-rejected`;
    const toolkit = 'composio_search';
    const action = 'duck_duck_go';
    let composioConfigured = false;
    let connectionId = '';
    let requestId: string | undefined;

    await ctx.step(
      'deployment status reports the exact configured connect providers without starting OAuth',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/connect-status');
        r.status(200).body().exists('$.configured');
        const status = r.json<{
          configured: boolean;
          provider: string | null;
          providers?: string[];
        }>();
        if (!('provider' in status)) throw new Error('connect-status omitted the provider key');
        const providers = status.providers ?? (status.provider ? [status.provider] : []);
        if (
          !Array.isArray(providers) ||
          providers.some((provider) => typeof provider !== 'string')
        ) {
          throw new Error('connect-status providers must be an array of strings');
        }
        if (status.configured !== providers.length > 0) {
          throw new Error(
            `connect-status configured=${status.configured} disagrees with providers=${providers.join(',')}`,
          );
        }
        if (status.provider !== (providers[0] ?? null)) {
          throw new Error(
            `connect-status provider=${status.provider} is not the first configured provider`,
          );
        }
        composioConfigured = providers.includes('composio');
      },
    );

    await ctx.step(
      'configured toolkit catalog exposes Composio, while missing config fails closed',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connect/toolkits', {
            params: { projectId: p.id },
            query: { q: 'search', limit: '20' },
          });
        if (!composioConfigured) {
          r.status([200, 501]);
          if (r.statusCode === 200 && r.json<{ provider?: string }>().provider === 'composio') {
            throw new Error('toolkit catalog returned Composio while connect-status omitted it');
          }
          return;
        }
        r.status(200).body().exists('$.items').exists('$.totalPages');
        const body = r.json<{
          items: Array<{ slug?: string; name?: string; isNoAuth?: boolean }>;
        }>();
        if (
          !body.items.some(
            (item) =>
              item.slug === toolkit && item.name === 'Composio Search' && item.isNoAuth === true,
          )
        ) {
          throw new Error(
            `Composio toolkit catalog omitted ${toolkit}: ${JSON.stringify(body.items.slice(0, 10))}`,
          );
        }
      },
    );

    await ctx.step(
      'project REST rejects an accidental Pipedream declaration and persists nothing',
      async () => {
        const rejected = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/connectors/projects/:projectId/connectors',
          {
            slug: rejectedLegacySlug,
            provider: 'pipedream',
            app: 'gmail',
            create_only: true,
          },
          { params: { projectId: p.id } },
        );
        rejected.status(400).body().exists('$.error');
        const error = rejected.json<{ error?: string }>().error ?? '';
        if (!error.includes('legacy rollback only') || !error.includes('composio')) {
          throw new Error(`unexpected Pipedream provider guard error: ${error}`);
        }

        const readback = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
            params: { projectId: p.id, slug: rejectedLegacySlug },
          });
        readback.status(404);
      },
    );

    await ctx.step(
      'real CLI process rejects accidental Pipedream before calling the project API',
      async () => {
        const cli = new CliSandbox('composio-provider-guard');
        try {
          const result = await cli.run(
            [
              'connectors',
              'add',
              rejectedLegacySlug,
              '--provider',
              'pipedream',
              '--app',
              'gmail',
              '--apply',
            ],
            {
              env: {
                KORTIX_TOKEN: cliPat,
                KORTIX_PROJECT_ID: p.id,
                KORTIX_API_URL: ctx.env.apiUrl,
              },
            },
          );
          throwIfCliInfraFailure(result, 'kortix connectors add Pipedream provider guard');
          if (result.exitCode !== 1) {
            throw new Error(`CLI Pipedream guard exited ${result.exitCode}: ${result.all}`);
          }
          if (
            !result.stderr.includes('Pipedream is legacy rollback only') ||
            !result.stderr.includes('--provider composio')
          ) {
            throw new Error(`CLI returned the wrong Pipedream guard: ${result.stderr}`);
          }
        } finally {
          cli.dispose();
        }
      },
    );

    await ctx.step(
      'Composio category filtering is provider-side and returns the complete category',
      async () => {
        if (!composioConfigured) return;
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connect/toolkits', {
            params: { projectId: p.id },
            query: { category: 'developer-tools', limit: '20' },
          });
        r.status(200)
          .body()
          .has('$.provider', 'composio')
          .has('$.hasMore', false)
          .exists('$.toolkits');
        const body = r.json<{
          toolkits: Array<{ slug?: string; categories?: string[] }>;
          total?: number;
        }>();
        if (body.total !== body.toolkits.length) {
          throw new Error(
            `category total ${body.total} did not match ${body.toolkits.length} returned toolkits`,
          );
        }
        if (!body.toolkits.some((item) => item.slug === toolkit)) {
          throw new Error(`developer-tools category omitted ${toolkit}`);
        }
        if (body.toolkits.some((item) => !item.categories?.includes('developer-tools'))) {
          throw new Error(
            'Composio returned an item outside the requested developer-tools category',
          );
        }
      },
    );

    await ctx.step(
      'declare a no-auth Composio toolkit without storing the platform key in project config',
      async () => {
        const created = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/connectors/projects/:projectId/connectors',
          {
            slug,
            provider: 'composio',
            app: toolkit,
            auth: { type: 'none' },
          },
          { params: { projectId: p.id } },
        );
        created.status(200).body().has('$.ok', true);

        const configResponse = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
            params: { projectId: p.id, slug },
          });
        configResponse
          .status(200)
          .body()
          .has('$.provider', 'composio')
          .has('$.app', toolkit)
          .has('$.auth.type', 'none');
        const config = configResponse.json<Record<string, unknown>>();
        if ('apiKey' in config || 'api_key' in config || 'credential' in config) {
          throw new Error(
            `Composio project config exposed a platform credential field: ${JSON.stringify(config)}`,
          );
        }
      },
    );

    await ctx.step(
      'connect creates the stable default connection, or reports missing Composio config',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/connectors/projects/:projectId/connectors/:slug/connect',
          {
            success_redirect_uri: 'kortix://connect/success',
            error_redirect_uri: 'kortix://connect/error',
          },
          { params: { projectId: p.id, slug } },
        );
        if (!composioConfigured) {
          r.status([404, 501]).body().exists('$.error');
          return;
        }
        r.status(200)
          .body()
          .has('$.provider', 'composio')
          .has('$.app', toolkit)
          .has('$.connected', true)
          .has('$.isNoAuth', true)
          .exists('$.sessionId')
          .exists('$.connectionId');
        const body = r.json<{
          connectUrl?: string | null;
          requestId?: string;
          sessionId: string;
          connectionId: string;
        }>();
        if (body.connectUrl)
          throw new Error(`no-auth toolkit returned an OAuth URL: ${body.connectUrl}`);
        if (!body.sessionId.startsWith('trs_'))
          throw new Error(`unexpected Composio session id: ${body.sessionId}`);
        connectionId = body.connectionId;
        requestId = body.requestId;
      },
    );

    // Deliberately ABOVE the provider branch. This route reads connection rows,
    // not the provider, so it must hold on a deployment with no Composio key —
    // and placing it after the early return below is how a step silently never
    // runs while the flow still reports PASS.
    //
    // The in-session Connect button reads this to know the agent is blocked. A
    // connect started by a dashboard JWT carries no requesting session, so it
    // must NOT appear here — otherwise every project would show a permanent
    // Connect card for work nobody is waiting on.
    await ctx.step('a connect with no requesting session reports nothing pending', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/sessions/:sessionId/connect-requests', {
          params: { projectId: p.id, sessionId: '00000000-0000-4000-a000-000000000000' },
        });
      r.status(200).body().has('$.connectors', []);
    });

    await ctx.step('wrong tenant cannot read what another project is waiting on', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/sessions/:sessionId/connect-requests', {
          params: { projectId: p.id, sessionId: '00000000-0000-4000-a000-000000000000' },
        });
      r.status(403);
    });

    if (!composioConfigured) {
      await ctx.step('finalize also fails closed when the server has no Composio key', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/connectors/projects/:projectId/connectors/:slug/connect/finalize',
            {},
            { params: { projectId: p.id, slug } },
          );
        r.status([404, 501]).body().exists('$.error');
      });

      await ctx.step('wrong tenant is rejected before missing-provider lookup', async () => {
        for (const op of ['connect', 'connect/finalize'] as const) {
          const r = await ctx.client.as(ctx.P.NONMEMBER).post(
            `/v1/connectors/projects/:projectId/connectors/:slug/${op}`,
            {},
            {
              params: { projectId: p.id, slug },
            },
          );
          r.status(403);
        }
      });
      return;
    }

    await ctx.step('finalize confirms the same no-auth connection identity', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors/:slug/connect/finalize',
        {
          connection_id: connectionId,
          ...(requestId ? { request_id: requestId } : {}),
        },
        { params: { projectId: p.id, slug } },
      );
      r.status(200)
        .body()
        .has('$.provider', 'composio')
        .has('$.connected', true)
        .has('$.connectionId', connectionId)
        .has('$.isNoAuth', true);
    });

    let otherConnectionId = '';
    await ctx.step(
      'a connection from another connector cannot finalize this connector',
      async () => {
        const created = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/connectors/projects/:projectId/connectors',
          {
            slug: otherSlug,
            provider: 'composio',
            app: toolkit,
            auth: { type: 'none' },
          },
          { params: { projectId: p.id } },
        );
        created.status(200).body().has('$.ok', true);
        const connected = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/connectors/projects/:projectId/connectors/:slug/connect',
            {},
            { params: { projectId: p.id, slug: otherSlug } },
          );
        connected.status(200).body().exists('$.connectionId');
        otherConnectionId = connected.json<{ connectionId: string }>().connectionId;
        if (otherConnectionId === connectionId)
          throw new Error('distinct connectors reused one connection id');

        const wrong = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/connectors/projects/:projectId/connectors/:slug/connect/finalize',
            { connection_id: otherConnectionId },
            { params: { projectId: p.id, slug } },
          );
        wrong.status(404).body().exists('$.error');
      },
    );

    await ctx.step('project REST catalog exposes the connected no-auth action', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/projects/:projectId/catalog', {
        params: { projectId: p.id },
      });
      r.status(200).body().exists('$.connectors');
      const connectors = r.json<{
        connectors: Array<{
          slug: string;
          provider: string;
          actions: Array<{ path: string }>;
        }>;
      }>().connectors;
      const connector = connectors.find((item) => item.slug === slug);
      if (!connector) throw new Error(`REST catalog omitted connected Composio connector ${slug}`);
      if (connector.provider !== 'composio')
        throw new Error(`REST catalog returned provider ${connector.provider}`);
      if (!connector.actions.some((item) => item.path === action)) {
        throw new Error(`REST catalog omitted ${slug}.${action}`);
      }
    });

    let restLogId = '';
    await ctx.step(
      'REST call executes the real provider and returns the provider log id',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/connectors/projects/:projectId/call',
            { connector: slug, action, args: { query: 'Kortix' } },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
        r.status(200)
          .body()
          .has('$.ok', true)
          .has('$.data.provider', 'composio')
          .exists('$.data.logId')
          .exists('$.data.requestId')
          .exists('$.data.sessionId')
          .exists('$.data.result');
        const data = r.json<{
          data: {
            logId: string;
            requestId: string;
            sessionId: string;
            result: unknown;
          };
        }>().data;
        if (data.logId !== data.requestId) {
          throw new Error(`provider logId ${data.logId} differs from requestId ${data.requestId}`);
        }
        restLogId = data.logId;
      },
    );

    await ctx.step(
      'real CLI lists and calls the same Composio action through project routes',
      async () => {
        const cli = new CliSandbox('composio');
        const env = {
          KORTIX_TOKEN: cliPat,
          KORTIX_PROJECT_ID: p.id,
          KORTIX_API_URL: ctx.env.apiUrl,
        };
        try {
          const listed = parseCliJson<{
            connectors: Array<{
              slug: string;
              provider: string;
              actions: Array<{ path: string }>;
            }>;
          }>(await cli.run(['connectors', 'ls', '--json'], { env }), 'kortix connectors ls');
          const connector = listed.connectors.find((item) => item.slug === slug);
          if (!connector) throw new Error(`CLI catalog omitted ${slug}`);
          if (connector.provider !== 'composio')
            throw new Error(`CLI catalog returned provider ${connector.provider}`);
          if (!connector.actions.some((item) => item.path === action)) {
            throw new Error(`CLI catalog omitted ${slug}.${action}`);
          }

          const called = parseCliJson<{
            ok: boolean;
            data: {
              provider: string;
              logId: string;
              requestId: string;
              result: unknown;
            };
          }>(
            await cli.run(
              ['connectors', 'call', `${slug}.${action}`, JSON.stringify({ query: 'Kortix' })],
              {
                env,
                timeoutMs: 60_000,
              },
            ),
            'kortix connectors call',
          );
          if (called.ok !== true)
            throw new Error(`CLI call did not report success: ${JSON.stringify(called)}`);
          if (called.data.provider !== 'composio')
            throw new Error(`CLI call returned provider ${called.data.provider}`);
          if (!called.data.logId || called.data.logId !== called.data.requestId) {
            throw new Error(
              `CLI call returned invalid provider log id: ${JSON.stringify(called.data)}`,
            );
          }
          if (called.data.logId === restLogId)
            throw new Error('REST and CLI calls unexpectedly reused one provider log id');
        } finally {
          cli.dispose();
        }
      },
    );

    await ctx.step(
      'real agent MCP schema defaults managed apps to Composio and exposes finalization',
      async () => {
        const cli = new CliSandbox('composio-mcp');
        const request = `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        })}\n`;
        try {
          const result = await cli.run(['connectors', 'mcp'], {
            env: {
              KORTIX_TOKEN: cliPat,
              KORTIX_PROJECT_ID: p.id,
              KORTIX_API_URL: ctx.env.apiUrl,
            },
            stdin: request,
          });
          throwIfCliInfraFailure(result, 'kortix connectors mcp tools/list');
          if (result.exitCode !== 0) {
            throw new Error(`MCP tools/list failed: ${result.all.slice(0, 2_000)}`);
          }
          const response = JSON.parse(result.stdout.trim()) as {
            result?: {
              tools?: Array<{
                name?: string;
                description?: string;
                inputSchema?: any;
              }>;
            };
          };
          const tools = response.result?.tools ?? [];
          const add = tools.find((tool) => tool.name === 'add_connector');
          const connect = tools.find((tool) => tool.name === 'connect');
          const finalize = tools.find((tool) => tool.name === 'finalize_connection');
          if (add?.inputSchema?.properties?.provider?.enum?.[0] !== 'composio') {
            throw new Error(
              `agent MCP did not default provider enum to Composio: ${JSON.stringify(add)}`,
            );
          }
          if (!String(add.description).includes('Composio is the default managed provider')) {
            throw new Error(
              `agent MCP omitted the Composio default instruction: ${JSON.stringify(add)}`,
            );
          }
          if (!add?.inputSchema?.properties?.allow_legacy_pipedream) {
            throw new Error('agent MCP omitted the explicit legacy Pipedream guard');
          }
          if (!String(connect?.description).includes('Composio')) {
            throw new Error(`agent MCP connect tool omitted Composio: ${JSON.stringify(connect)}`);
          }
          if (
            !finalize?.inputSchema?.properties?.connection_id ||
            !finalize?.inputSchema?.properties?.request_id
          ) {
            throw new Error(
              `agent MCP omitted provider authorization finalization: ${JSON.stringify(finalize)}`,
            );
          }
        } finally {
          cli.dispose();
        }
      },
    );

    await ctx.step('canonical audit readback contains both successful provider calls', async () => {
      const reconciled = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/:accountId/audit/reconcile', undefined, {
          params: { accountId: team.id },
          query: { limit: '100' },
        });
      reconciled.status(200).body().exists('$.inserted').exists('$.complete');

      const audit = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/audit', {
        params: { projectId: p.id },
        query: {
          action: `connector.${slug}.${action}`,
          resource_type: 'connector_call',
          outcome: 'success',
          limit: '10',
        },
      });
      audit.status(200).body().exists('$.events');
      const events = audit.json<{
        events: Array<{
          action: string;
          outcome: string;
          resource_type: string;
          source_ledger: string | null;
        }>;
      }>().events;
      const matching = events.filter(
        (event) =>
          event.action === `connector.${slug}.${action}` &&
          event.outcome === 'success' &&
          event.resource_type === 'connector_call' &&
          event.source_ledger === 'connector_calls',
      );
      if (matching.length < 2) {
        throw new Error(
          `audit readback contained ${matching.length} matching calls, expected REST + CLI`,
        );
      }
    });

    await ctx.step(
      'wrong tenant cannot connect or finalize another project connector',
      async () => {
        for (const op of ['connect', 'connect/finalize'] as const) {
          const r = await ctx.client.as(ctx.P.NONMEMBER).post(
            `/v1/connectors/projects/:projectId/connectors/:slug/${op}`,
            {},
            {
              params: { projectId: p.id, slug },
            },
          );
          r.status(403);
        }
      },
    );

  },
);

flow(
  'CONN-25',
  {
    domain: 'connectors',
    serial: true,
    timeoutMs: 180_000,
    routes: [
      'GET /v1/connectors/connect-status',
      'POST /v1/connectors/projects/:projectId/connectors',
      'POST /v1/connectors/projects/:projectId/connectors/:slug/connect',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const slug = `ke2e-gmail-oauth-${Date.now().toString(36)}`;

    const status = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/connect-status');
    status.status(200);
    const statusBody = status.json<{ provider: string | null; providers?: string[] }>();
    const providers = statusBody.providers ?? (statusBody.provider ? [statusBody.provider] : []);
    if (!providers.includes('composio')) return;

    await ctx.step('declare Gmail as a Composio-managed OAuth connector', async () => {
      const created = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        {
          slug,
          name: 'Gmail OAuth regression',
          provider: 'composio',
          app: 'gmail',
          auth: { type: 'none' },
          create_only: true,
        },
        { params: { projectId: p.id } },
      );
      created.status(200).body().has('$.ok', true);
    });

    await ctx.step('connect returns a fresh Composio Gmail authorization request', async () => {
      const connected = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors/:slug/connect',
        {
          success_redirect_uri: 'https://dev.kortix.com/oauth-proof',
          error_redirect_uri: 'https://dev.kortix.com/oauth-proof-error',
        },
        { params: { projectId: p.id, slug } },
      );
      connected
        .status(200)
        .body()
        .has('$.provider', 'composio')
        .has('$.app', 'gmail')
        .has('$.connected', false)
        .has('$.isNoAuth', false)
        .exists('$.connectUrl')
        .exists('$.sessionId')
        .exists('$.connectionId')
        .exists('$.requestId');
      const body = connected.json<{
        connectUrl: string;
        sessionId: string;
        requestId: string;
      }>();
      const connectUrl = new URL(body.connectUrl);
      if (connectUrl.protocol !== 'https:' || connectUrl.hostname !== 'connect.composio.dev') {
        throw new Error(`unexpected Gmail Connect Link origin: ${connectUrl.origin}`);
      }
      if (!body.sessionId.startsWith('trs_')) {
        throw new Error(`unexpected Gmail Composio session id: ${body.sessionId}`);
      }
      if (!body.requestId.trim()) throw new Error('Gmail authorization request id was empty');
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
    const defaultConnection = await ctx.client
      .as(ctx.P.OWNER)
      .post(
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
      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/connections/:connectionId/oauth2/application', {
          params: { projectId: p.id, connectionId },
        });
      read
        .status(200)
        .body()
        .has('$.application.client_id', 'ke2e-public-client')
        .has('$.application.has_client_secret', false);
    });

    await ctx.step('start Authorization Code with PKCE and read ready status', async () => {
      const started = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/connections/:connectionId/oauth2/authorize',
          {},
          { params: { projectId: p.id, connectionId } },
        );
      started.status(200).body().exists('$.authorization_url').exists('$.expires_at');
      const status = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/connections/:connectionId/oauth2/status', {
          params: { projectId: p.id, connectionId },
        });
      status.status(200).body().has('$.status', 'ready');
    });

    await ctx.step('reject SSRF discovery and unavailable device endpoints', async () => {
      const discovery = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/connections/:connectionId/oauth2/discover',
        {
          discovery_url: 'https://127.0.0.1/.well-known/oauth-authorization-server',
        },
        { params: { projectId: p.id, connectionId } },
      );
      discovery.status(400);
      const device = await ctx.client
        .as(ctx.P.OWNER)
        .post(
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
        const ownResource = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/connections/:connectionId/oauth2/discover-resource',
            {},
            { params: { projectId: p.id, connectionId } },
          );
        ownResource.status(400).body().exists('$.error');
        const loopbackResource = await ctx.client
          .as(ctx.P.OWNER)
          .post(
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
        const incompleteRegistration = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/connections/:connectionId/oauth2/register',
            { registration_endpoint: 'https://identity.example.com/register' },
            { params: { projectId: p.id, connectionId } },
          );
        incompleteRegistration.status(400);
        // A non-member is stopped by the project gate before the connection
        // is ever looked up, so this is 403 — the same code every other
        // NONMEMBER step in this flow asserts — not the handler's 404.
        const foreign = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post(
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
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/setup-links/connectors/:token', {
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
    await ctx.step(
      'POST .../finalize with a bogus token → 404 (invalid/unknown link)',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .post(
            '/v1/setup-links/connectors/:token/finalize',
            {},
            { params: { token: 'bogus-connector-setup-link' } },
          );
        r.status(404).body().exists('$.error');
      },
    );
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
  {
    domain: 'connectors',
    routes: ['POST /v1/projects/:projectId/connect-requests'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing slug → 400, or 501 when Pipedream is disabled', async () => {
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
