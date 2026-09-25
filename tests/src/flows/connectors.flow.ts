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
      'GET /v1/connectors/projects/:projectId/discover/sections',
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
    await ctx.step(
      'browse sections state each section total that its category filter returns',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/discover/sections', {
            params: { projectId: p.id },
            query: { perCategory: '6', maxCategories: '12' },
          });
        r.status([200, 502]);
        if (r.statusCode !== 200) return;
        r.body().exists('$.popular').exists('$.sections').exists('$.categories');
        const body = r.json<{
          popular: unknown[];
          sections: Array<{ key: string; total: number; items: unknown[] }>;
          categories: Array<{ key: string; count: number }>;
        }>();
        if (body.popular.length > 6) {
          throw new Error(`Popular carried ${body.popular.length} cards over a 6-card slice`);
        }
        if (body.sections.length === 0 || body.sections.length > 12) {
          throw new Error(`expected 1..12 sections, got ${body.sections.length}`);
        }
        for (const section of body.sections) {
          if (section.items.length > 6 || section.total < section.items.length) {
            throw new Error(
              `section ${section.key} reports total ${section.total} over ${section.items.length} cards`,
            );
          }
          const facet = body.categories.find((category) => category.key === section.key);
          if (facet?.count !== section.total) {
            throw new Error(`category facet for ${section.key} disagrees with its section total`);
          }
        }
        // The regression: headings counted one 48-item page of a ~5500-item
        // catalogue. The largest section of the complete index is far bigger.
        const largest = [...body.sections].sort((a, b) => b.total - a.total)[0];
        if (largest.total <= largest.items.length) {
          throw new Error(`largest section ${largest.key} reports only ${largest.total}`);
        }
        const opened = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/discover/connectors', {
            params: { projectId: p.id },
            query: { category: largest.key, limit: '24' },
          });
        opened.status(200);
        const page = opened.json<{ total?: number }>();
        if (page.total !== largest.total) {
          throw new Error(
            `section ${largest.key} heading says ${largest.total}, its category filter returns ${page.total}`,
          );
        }
      },
    );
    await ctx.step('NONMEMBER cannot browse or resolve catalogue records', async () => {
      const list = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/discover/connectors', {
          params: { projectId: p.id },
        });
      list.status(403);
      const sections = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/connectors/projects/:projectId/discover/sections', {
          params: { projectId: p.id },
        });
      sections.status(403);
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

    // `authorization_strategy` was a connector-level MODE that made
    // project-owned and member-owned connections mutually exclusive. It is
    // redundant with each connection's own `owner_type`, and it was the direct
    // cause of the dead end: a `user`-strategy connector had no connect flow at
    // all. The route stays mounted and answers a deprecation no-op, because an
    // old client calling it must not start failing.
    await ctx.step('authorization strategy: deprecated no-op → 200 {ok, deprecated}', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/connectors/projects/:projectId/connectors/:slug/authorization-strategy',
          { authorization_strategy: 'user' },
          { params: { projectId: p.id, slug: 'nope' } },
        );
      // 200 against a slug that does not exist: the handler looks nothing up
      // any more, which is the proof it changes nothing.
      r.status(200).body().has('$.ok', true).has('$.deprecated', true);
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
      // `owner_type` is the whole access rule now: a `project` row is shared
      // with everyone the connector is granted to. No connector-level strategy
      // gates this route any more.
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

    // /me reconciles the CALLER's own member connection. It used to need a
    // 'user'-strategy connector, so this step had to flip the strategy first —
    // three extra requests, a manifest read race, and a retry loop, all to
    // satisfy a flag. A connector now carries the project's shared account and
    // each member's own side by side, so /me works on the same connector.
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

    await ctx.step(
      'reconciling the SAME label after a revoke re-activates that row (a re-connect, not a metadata touch)',
      async () => {
        // The web header's "Add credential" on a connector whose only shared
        // account was just disconnected reconciles the same label and then sets
        // a credential on the returned row. Left `revoked`, that row kept the
        // credential but stayed out of every usable-accounts list.
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections',
          { connector_alias: slug, owner_type: 'project', label: 'KE2E connection' },
          { params: { projectId: p.id } },
        );
        r.status([200, 201])
          .body()
          .has('$.connection_id', connectionId)
          .has('$.status', 'active');
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
  'CONN-RENAME',
  {
    domain: 'connectors',
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/projects/:projectId/connections',
      'POST /v1/projects/:projectId/connections',
      'PUT /v1/projects/:projectId/connections/:connectionId/label',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const slug = `ke2e-rename-${Date.now().toString(36)}`;
    const rename = (connectionId: string, body: unknown, as = ctx.P.OWNER) =>
      ctx.client.as(as).put('/v1/projects/:projectId/connections/:connectionId/label', body, {
        params: { projectId: p.id, connectionId },
      });
    const listed = async () =>
      (
        await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/connections', {
          params: { projectId: p.id },
        })
      ).json<{ connections: Array<Record<string, unknown>> }>().connections;

    await ctx.step('seed a connector with two project connections', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/connectors/projects/:projectId/connectors',
        { slug, provider: 'mcp', url: 'https://ke2e.kortix.test/mcp', auth: { type: 'none' } },
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.ok', true);
    });

    let primaryId = '';
    let backupId = '';
    await ctx.step('create "Project connection" and "Backup" → 201 each', async () => {
      for (const label of ['Project connection', 'Backup']) {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/connections',
          { connector_alias: slug, owner_type: 'project', label },
          { params: { projectId: p.id } },
        );
        r.status(201).body().has('$.label', label);
        if (label === 'Backup') backupId = r.json<any>().connection_id;
        else primaryId = r.json<any>().connection_id;
      }
    });

    await ctx.step(
      'rename "Project connection" → 200 with the new label; id, owner, status, and default are unchanged',
      async () => {
        const [before] = (await listed()).filter((row) => row.connection_id === primaryId);
        const r = await rename(primaryId, { label: '  Shared support inbox  ' });
        r.status(200)
          .body()
          .has('$.connection_id', primaryId)
          .has('$.label', 'Shared support inbox')
          .has('$.owner_type', 'project')
          .has('$.status', before!.status as string)
          .has('$.is_default', before!.is_default as boolean);
      },
    );

    await ctx.step('the connection list reads back the new label and a connected_as field', async () => {
      const row = (await listed()).find((item) => item.connection_id === primaryId);
      if (row?.label !== 'Shared support inbox') {
        throw new Error(`list returned label ${JSON.stringify(row?.label)}`);
      }
      if (!('connected_as' in row)) throw new Error('list row has no connected_as field');
      if (row.connected_as !== null) {
        throw new Error(`an unauthorized MCP row reported connected_as ${JSON.stringify(row.connected_as)}`);
      }
    });

    await ctx.step('renaming to the current label → 200, no change', async () => {
      (await rename(primaryId, { label: 'Shared support inbox' }))
        .status(200)
        .body()
        .has('$.label', 'Shared support inbox');
    });

    await ctx.step('a label another account of the same owner has, in any case → 409', async () => {
      (await rename(primaryId, { label: 'BACKUP' })).status(409);
      const row = (await listed()).find((item) => item.connection_id === primaryId);
      if (row?.label !== 'Shared support inbox') throw new Error('a refused rename changed the label');
    });

    await ctx.step('reserved selector words, an id-shaped label, and an empty label → 400', async () => {
      for (const label of ['me', 'Project', '00000000-0000-4000-a000-000000000000', '   ']) {
        (await rename(backupId, { label })).status(400);
      }
      (await rename(backupId, { label: 'Fine', extra: true })).status(400);
      (await rename(backupId, {})).status(400);
    });

    await ctx.step('an unknown connection → 404; a non-member → 403/404; anonymous → 401', async () => {
      (await rename('00000000-0000-4000-a000-000000000000', { label: 'Nope' })).status(404);
      (await rename(backupId, { label: 'Nope' }, ctx.P.NONMEMBER)).status([403, 404]);
      (await rename(backupId, { label: 'Nope' }, ctx.P.ANON)).status(401);
    });

    await ctx.step(
      'the real CLI renames by id (`connections rename <id> <label…>`) and lists the new label',
      async () => {
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('rename-cli') });
        const cli = new CliSandbox('connections-rename');
        const env = { KORTIX_TOKEN: pat, KORTIX_PROJECT_ID: p.id, KORTIX_API_URL: ctx.env.apiUrl };
        try {
          const renamed = parseCliJson<{ connection_id: string; label: string }>(
            await cli.run(['connectors', 'connections', 'rename', backupId, 'Backup', 'inbox', '--json'], {
              env,
            }),
            'kortix connectors connections rename',
          );
          if (renamed.connection_id !== backupId || renamed.label !== 'Backup inbox') {
            throw new Error(`CLI rename returned ${JSON.stringify(renamed)}`);
          }
          const plain = await cli.run(['connectors', 'connections', 'rename', backupId, 'Backup mailbox'], {
            env,
          });
          throwIfCliInfraFailure(plain, 'kortix connectors connections rename (text)');
          if (plain.exitCode !== 0 || !plain.stdout.includes('Backup mailbox')) {
            throw new Error(`CLI text rename exited ${plain.exitCode}: ${plain.all}`);
          }
          const refused = await cli.run(['connectors', 'connections', 'rename', backupId, 'me'], { env });
          throwIfCliInfraFailure(refused, 'kortix connectors connections rename me');
          if (refused.exitCode === 0 || !/reserved/i.test(refused.all)) {
            throw new Error(`CLI accepted a reserved label: ${refused.all}`);
          }
          const rows = parseCliJson<{ connections: Array<{ connection_id: string; label: string }> }>(
            await cli.run(['connectors', 'connections', 'ls', '--json'], { env }),
            'kortix connectors connections ls',
          ).connections;
          const row = rows.find((item) => item.connection_id === backupId);
          if (row?.label !== 'Backup mailbox') {
            throw new Error(`CLI list returned ${JSON.stringify(row)}`);
          }
        } finally {
          cli.dispose();
        }
      },
    );
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
      'GET /v1/connectors/projects/:projectId/connect/sections',
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
      'Composio browse sections state each category total that its View all filter returns',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connect/sections', {
            params: { projectId: p.id },
            query: { perCategory: '6', maxCategories: '12' },
          });
        if (!composioConfigured) {
          r.status(501);
          return;
        }
        r.status(200).body().has('$.provider', 'composio').exists('$.sections').exists('$.categories');
        const body = r.json<{
          sections: Array<{
            key: string;
            total: number;
            toolkits: Array<{ slug: string; categories?: string[] }>;
          }>;
          categories: Array<{ key: string; count: number }>;
        }>();
        if (body.sections.length === 0 || body.sections.length > 12) {
          throw new Error(`expected 1..12 sections, got ${body.sections.length}`);
        }
        const totals = body.sections.map((section) => section.total);
        if (totals.some((total, index) => index > 0 && total > totals[index - 1])) {
          throw new Error(`sections are not ordered largest first: ${totals.join(',')}`);
        }
        const largest = body.sections[0];
        // The regression: a total equal to the loaded card count (`· 1`). The
        // largest Composio category holds hundreds of toolkits.
        if (largest.toolkits.length > 6 || largest.total <= largest.toolkits.length) {
          throw new Error(
            `largest section ${largest.key} reports total ${largest.total} over ${largest.toolkits.length} cards`,
          );
        }
        for (const section of body.sections) {
          if (section.toolkits.some((item) => !item.categories?.includes(section.key))) {
            throw new Error(`section ${section.key} carried a toolkit outside its category`);
          }
          const facet = body.categories.find((category) => category.key === section.key);
          if (facet?.count !== section.total) {
            throw new Error(`category facet for ${section.key} disagrees with its section total`);
          }
        }

        const viewAll = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/connectors/projects/:projectId/connect/toolkits', {
            params: { projectId: p.id },
            query: { category: largest.key, limit: '20' },
          });
        viewAll.status(200);
        const opened = viewAll.json<{ total?: number }>();
        if (opened.total !== largest.total) {
          throw new Error(
            `section ${largest.key} heading says ${largest.total}, View all returns ${opened.total}`,
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
      'REST call executes the real provider, returns the provider log id, and names the account it ran as',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/connectors/projects/:projectId/call',
            // NAME THE ACCOUNT. Since #7326 an unnamed call is DENIED
            // `account_required` whenever more than one account is reachable
            // and none is pinned as default — the deliberate replacement for
            // silently guessing a mailbox. This flow's own setup leaves two
            // reachable ("Private connection" plus this connector's own), so
            // the unnamed form correctly returned 403 on the v0.13.24 gate:
            //   {"ok":false,"status":"denied","reason":"account_required",
            //    "available_accounts":["Private connection","ke2e-composio-…"]}
            // `account` takes a connection label or id; the id is unambiguous.
            { connector: slug, action, args: { query: 'Kortix' }, account: connectionId },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
        r.status(200)
          .body()
          .has('$.ok', true)
          .has('$.data.provider', 'composio')
          .exists('$.data.logId')
          .exists('$.data.requestId')
          .exists('$.data.sessionId')
          .exists('$.data.result')
          // A connector can hold the project's shared account and each member's
          // own, so "it worked" is not enough — the transcript has to say WHICH
          // identity ran. The call named no account, so this is the default the
          // connect step above created.
          .has('$.account.connection_id', connectionId)
          .exists('$.account.label')
          .exists('$.account.owner_type');
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
              // Same `account_required` contract through the real CLI process:
              // `--account` is the CLI's spelling of the REST `account` field.
              ['connectors', 'call', `${slug}.${action}`, JSON.stringify({ query: 'Kortix' }),
                '--account', connectionId],
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
    // A project-owned connection: the OAuth2 application under test is the
    // project's shared one. `owner_type` is a free choice on this route now —
    // no connector-level strategy constrains it.
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

// ── CONN-27 — session grant provenance, channel guarantee, honest denials ────
// INC-2026-09-08-CONNECTOR-GATEWAY. A live session's connector access is
// decided per call from the token's agent grant, which is re-derived from the
// project manifest. This flow drives that path with a REAL session-bound token
// (minted the way the sandbox's own KORTIX_TOKEN is) and proves:
//   1. a stale narrow grant is re-pointed at the manifest and stamped with the
//      manifest blob + commit it came from (hot reload of a mid-session change);
//   2. a glitched token grant on the SAME manifest blob is repaired by two
//      consistent reads, never kept;
//   3. the channel that created the session stays callable under a grant that
//      excludes it — the agent is never mute;
//   4. `connector_not_assigned` names the agent, its grant and the manifest;
//      a declared connector with no credential answers `connector_not_connected`
//      and lists as `needs_auth`;
//   5. the turn-stream relay says WHY a step was not relayed;
//   6. ten consecutive calls after a mid-session connector add keep the grant.
flow(
  'CONN-27',
  {
    domain: 'connectors',
    requires: ['database'],
    // Includes managed Git writes and ten sequential manifest reads on deployed targets.
    timeoutMs: 300_000,
    routes: [
      'POST /v1/accounts/tokens',
      'POST /v1/connectors/projects/:projectId/call',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/connectors/projects/:projectId/connectors',
      'POST /v1/connectors/projects/:projectId/connectors',
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'POST /v1/projects/:projectId/turn-stream',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    // `managedGit` on the LOCAL target is a local bare repository (no GitHub),
    // which is what the gateway's manifest read needs; the capability gate is
    // the deployed-target one and is deliberately not required here.
    const p = await team.project({ managedGit: true });
    const ownerUserId = ctx.P.OWNER.userId;
    if (!ownerUserId) throw new Error('OWNER principal has no userId');
    // Declare the agent in kortix.yaml (a real manifest commit in the project
    // repository) so the gateway has something to derive the grant from.
    const declare = await ctx.client.as(ctx.P.OWNER).put(
      '/v1/projects/:projectId/agents/:agentName/config',
      { connectors: 'all', secrets: 'all', kortix_permissions: 'all', skills: 'all' },
      { params: { projectId: p.id, agentName: 'kortix' }, timeoutMs: 60_000 },
    );
    declare.status(200);

    const { randomUUID } = await import('node:crypto');
    const { Client: PgClient } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new PgClient({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });

    const sessionId = randomUUID();
    const openapiSlug = `ke2e-openapi-${Date.now().toString(36)}`;
    let tokenId: string | null = null;
    let session = ctx.client;
    const call = (connector: string, action: string) =>
      session.post(
        '/v1/connectors/projects/:projectId/call',
        { connector, action, args: {} },
        { params: { projectId: p.id }, timeoutMs: 60_000 },
      );
    const readGrant = async () => {
      const r = await db.query<{ agent_grant: Record<string, unknown> | null }>(
        `SELECT agent_grant FROM kortix.account_tokens WHERE session_id = $1 AND status = 'active'`,
        [sessionId],
      );
      return r.rows[0]?.agent_grant ?? null;
    };
    const HEX40 = /^[0-9a-f]{40}$/;

    try {
      await db.connect();
      await ctx.step('seed a Slack-born session, its sandbox row, and a session-bound token', async () => {
        const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', {
          name: `CONN-27 session ${sessionId.slice(0, 8)}`,
        });
        minted.status(201);
        const credential = minted.json<{ token_id: string; secret_key: string }>();
        tokenId = credential.token_id;
        session = ctx.client.withBearer(credential.secret_key, 'SESSION_TOKEN');
        await db.query(
          `INSERT INTO kortix.project_sessions
             (session_id, account_id, project_id, branch_name, agent_name, status, metadata, created_by, visibility)
           VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4::jsonb, $5, 'project')`,
          [
            sessionId,
            team.id,
            p.id,
            JSON.stringify({
              source: 'slack',
              slack: { channel: 'C0KE2E', thread_ts: '1788825004.144689', team_id: 'TKE2E' },
            }),
            ownerUserId,
          ],
        );
        await db.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
           VALUES ($1::uuid, $1, $2, $3, 'active')`,
          [sessionId, team.id, p.id],
        );
        // The stale narrow grant a token minted before the manifest changed
        // would hold: only `stripe`, no provenance at all.
        await db.query(
          `UPDATE kortix.account_tokens
             SET account_id = $2, user_id = $3, project_id = $4,
                 session_id = $5, agent_grant = $6::jsonb
           WHERE token_id = $1`,
          [
            tokenId,
            team.id,
            ownerUserId,
            p.id,
            sessionId,
            JSON.stringify({ agent: 'kortix', connectors: ['stripe'], permissions: [], env: [] }),
          ],
        );
        // A declared openapi connector with bearer auth and NO credential
        // (the shape of the incident's heyreach_api / smartlead rows), with its
        // project-default connection; and the Slack channel connector.
        const openapi = await db.query<{ connector_id: string }>(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, $3, 'KE2E OpenAPI', 'openapi', $4::jsonb, 'active') RETURNING connector_id`,
          [team.id, p.id, openapiSlug, JSON.stringify({ base_url: 'https://ke2e.kortix.test', auth: { type: 'bearer' } })],
        );
        await db.query(
          `INSERT INTO kortix.connector_connections (account_id, project_id, connector_id, owner_type, label, status, is_default, metadata)
           VALUES ($1, $2, $3, 'project', 'KE2E OpenAPI', 'active', true, $4::jsonb)`,
          [team.id, p.id, openapi.rows[0]?.connector_id, JSON.stringify({ provider: 'openapi', connector_slug: openapiSlug })],
        );
        await db.query(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, 'kortix_slack', 'Slack', 'channel', $3::jsonb, 'active')
           ON CONFLICT DO NOTHING`,
          [team.id, p.id, JSON.stringify({ platform: 'slack' })],
        );
      });

      await ctx.step(
        'the first call re-points the stale grant at the manifest (connectors: all) and stamps provenance',
        async () => {
          const r = await call(openapiSlug, 'anything');
          // Not the grant gate: the manifest grants `all`, so the token is
          // widened and the call proceeds to connection resolution.
          if (r.statusCode === 403 && r.json<{ reason?: string }>().reason === 'connector_not_assigned') {
            throw new Error(`grant was not reconciled from the manifest: ${r.text()}`);
          }
          const grant = await readGrant();
          if (!grant) throw new Error('session token lost its grant');
          if (grant.connectors !== 'all') {
            throw new Error(`expected the manifest grant (all), got ${JSON.stringify(grant)}`);
          }
          if (!HEX40.test(String(grant.manifestRevision))) {
            throw new Error(`grant carries no manifest blob provenance: ${JSON.stringify(grant)}`);
          }
          if (!HEX40.test(String(grant.manifestCommit))) {
            throw new Error(`grant carries no manifest commit provenance: ${JSON.stringify(grant)}`);
          }
        },
      );

      await ctx.step(
        'a declared connector with no credential answers connector_not_connected (not "not found") with a hint',
        async () => {
          const r = await call(openapiSlug, 'anything');
          r.status(403)
            .body()
            .has('$.ok', false)
            .has('$.status', 'denied')
            .has('$.reason', 'connector_not_connected')
            .has('$.connector', openapiSlug)
            .exists('$.hint');
          if (!String(r.json<{ hint: string }>().hint).includes(`kortix connectors connect ${openapiSlug}`)) {
            throw new Error(`hint does not name the fix: ${r.text()}`);
          }
        },
      );

      await ctx.step('the project list reports that connector as needs_auth, not active', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/connectors/projects/:projectId/connectors', {
          params: { projectId: p.id },
        });
        r.status(200);
        const row = r
          .json<{ connectors: Array<{ slug: string; status: string; secretSet?: boolean }> }>()
          .connectors.find((c) => c.slug === openapiSlug);
        if (!row) throw new Error(`project list omitted ${openapiSlug}`);
        if (row.status !== 'needs_auth') {
          throw new Error(`expected needs_auth for a connector with no credential, got ${row.status}`);
        }
      });

      await ctx.step(
        'a glitched deny-all grant on the SAME manifest blob is repaired by two consistent reads',
        async () => {
          const before = await readGrant();
          const glitched = { ...(before ?? {}), connectors: [], permissions: [], env: [] };
          await db.query(`UPDATE kortix.account_tokens SET agent_grant = $1::jsonb WHERE session_id = $2`, [
            JSON.stringify(glitched),
            sessionId,
          ]);
          const r = await call(openapiSlug, 'anything');
          if (r.statusCode === 403 && r.json<{ reason?: string }>().reason === 'connector_not_assigned') {
            throw new Error(`the glitched grant was served instead of repaired: ${r.text()}`);
          }
          const after = await readGrant();
          if (!after || after.connectors !== 'all') {
            throw new Error(`grant was not repaired: ${JSON.stringify(after)}`);
          }
        },
      );

      await ctx.step(
        'narrowing the agent in kortix.yaml applies on the next call, and the denial names agent, grant and manifest',
        async () => {
          const put = await ctx.client.as(ctx.P.OWNER).put(
            '/v1/projects/:projectId/agents/:agentName/config',
            { connectors: ['stripe'], secrets: 'all', kortix_permissions: 'all', skills: 'all' },
            { params: { projectId: p.id, agentName: 'kortix' }, timeoutMs: 60_000 },
          );
          put.status(200);
          const r = await call(openapiSlug, 'anything');
          r.status(403)
            .body()
            .has('$.reason', 'connector_not_assigned')
            .has('$.agent', 'kortix')
            .has('$.connector', openapiSlug)
            .exists('$.manifest_revision')
            .exists('$.manifest_commit')
            .exists('$.hint');
          const body = r.json<{ granted: unknown; manifest_revision: string; hint: string }>();
          if (JSON.stringify(body.granted) !== JSON.stringify(['stripe'])) {
            throw new Error(`denial did not name the granted list: ${r.text()}`);
          }
          if (!HEX40.test(body.manifest_revision)) {
            throw new Error(`denial did not name the manifest blob: ${r.text()}`);
          }
          if (!body.hint.includes('agents.kortix.connectors')) {
            throw new Error(`denial hint does not point at kortix.yaml: ${r.text()}`);
          }
        },
      );

      await ctx.step(
        "the session's own Slack channel connector stays callable under the narrow grant (never mute)",
        async () => {
          const r = await call('kortix_slack', 'auth_test');
          const reason = r.json<{ reason?: string }>().reason;
          if (reason === 'connector_not_assigned') {
            throw new Error(`the originating channel was denied by the grant: ${r.text()}`);
          }
          // No Slack install exists here, so the call fails AFTER the gate on
          // connection resolution — which is the proof the gate let it through.
          if (r.statusCode !== 403 && r.statusCode !== 404) {
            throw new Error(`expected a post-gate connection denial, got ${r.statusCode}: ${r.text()}`);
          }
          const catalog = await session.get('/v1/connectors/projects/:projectId/catalog', {
            params: { projectId: p.id },
          });
          catalog.status(200);
          const slugs = catalog.json<{ connectors: Array<{ slug: string }> }>().connectors.map((c) => c.slug);
          if (slugs.includes(openapiSlug)) {
            throw new Error(`catalog listed a connector outside the grant: ${slugs.join(',')}`);
          }
        },
      );

      await ctx.step('a progress step with no open Slack turn is refused WITH a reason', async () => {
        const r = await session.post(
          '/v1/projects/:projectId/turn-stream',
          { session_id: sessionId, kind: 'step', text: 'Reading the logs' },
          { params: { projectId: p.id } },
        );
        r.status(200).body().has('$.ok', false).has('$.reason', 'no_open_turn');
      });

      await ctx.step(
        'ten calls after a mid-session connector add keep the grant (no lossy re-resolution)',
        async () => {
          const added = `${openapiSlug}-added`;
          const create = await ctx.client.as(ctx.P.OWNER).post(
            '/v1/connectors/projects/:projectId/connectors',
            {
              slug: added,
              name: 'Added mid-session',
              provider: 'mcp',
              url: 'https://ke2e.kortix.test/mcp',
              auth: { type: 'none' },
              create_only: true,
            },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
          create.status([200, 409]);
          for (let i = 0; i < 10; i += 1) {
            const r = await call(openapiSlug, 'anything');
            const body = r.json<{ reason?: string; granted?: unknown }>();
            // Still narrowed to `stripe` by the manifest — and ALWAYS for that
            // reason, never an empty grant.
            if (body.reason !== 'connector_not_assigned') {
              throw new Error(`call ${i + 1}: expected the manifest's narrowing, got ${r.text()}`);
            }
            if (JSON.stringify(body.granted) !== JSON.stringify(['stripe'])) {
              throw new Error(`call ${i + 1}: grant drifted from the manifest: ${r.text()}`);
            }
          }
          const grant = await readGrant();
          if (!grant || JSON.stringify(grant.connectors) !== JSON.stringify(['stripe'])) {
            throw new Error(`token grant drifted after ten calls: ${JSON.stringify(grant)}`);
          }
        },
      );
    } finally {
      await db
        .query(`DELETE FROM kortix.account_tokens WHERE token_id = $1`, [tokenId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.session_sandboxes WHERE session_id = $1`, [sessionId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.project_sessions WHERE session_id = $1`, [sessionId])
        .catch(() => undefined);
      await db.end().catch(() => undefined);
    }
  },
);

// One connector, several accounts. `authorization_strategy` used to make
// project-owned and member-owned connections mutually exclusive per connector,
// which is why a "private" connector had no shared account to offer and no
// connect flow either. The rule is now per connection row: a `project` row is
// reachable by anyone the connector is granted to, a `member` row only by its
// own owner and only in a private session. This flow pins the three surfaces
// that fall out of it — the list, the denial that names what WAS available, and
// the grant gate in front of both.
flow(
  'CONN-ACCOUNTS',
  {
    domain: 'connectors',
    requires: ['database'],
    // Two manifest writes (the agent config PUT and its narrowing) are Git
    // commit round-trips on a managed project.
    timeoutMs: 180_000,
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/connectors/projects/:projectId/connectors/:slug/accounts',
      'POST /v1/connectors/projects/:projectId/call',
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'PUT /v1/projects/:projectId/connections/:connectionId/default',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    // `managedGit` on the LOCAL target is a local bare repository: the agent
    // config PUT commits kortix.yaml, which is where the grant is read from.
    const p = await team.project({ managedGit: true });
    const ownerUserId = ctx.P.OWNER.userId;
    if (!ownerUserId) throw new Error('OWNER principal has no userId');

    const { randomUUID } = await import('node:crypto');
    const { Client: PgClient } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new PgClient({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });

    const sessionId = randomUUID();
    const slug = `ke2e-accounts-${Date.now().toString(36)}`;
    const SHARED_DEFAULT = 'Shared default';
    const SHARED_SECOND = 'Shared backup';
    const PRIVATE_OWN = 'My own';
    let tokenId: string | null = null;
    let connectorId = '';
    let sharedDefaultId = '';
    let privateOwnId = '';
    let session = ctx.client;

    const readAccounts = (client: typeof ctx.client) =>
      client.get('/v1/connectors/projects/:projectId/connectors/:slug/accounts', {
        params: { projectId: p.id, slug },
      });
    const declareAgent = (connectorsGrant: 'all' | string[]) =>
      ctx.client.as(ctx.P.OWNER).put(
        '/v1/projects/:projectId/agents/:agentName/config',
        { connectors: connectorsGrant, secrets: 'all', kortix_permissions: 'all', skills: 'all' },
        { params: { projectId: p.id, agentName: 'kortix' }, timeoutMs: 60_000 },
      );

    try {
      await db.connect();

      await ctx.step(
        'seed one connector holding two shared accounts and the caller’s own private one',
        async () => {
          const declared = await declareAgent('all');
          declared.status(200);
          const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', {
            name: `CONN-ACCOUNTS session ${sessionId.slice(0, 8)}`,
          });
          minted.status(201);
          const credential = minted.json<{ token_id: string; secret_key: string }>();
          tokenId = credential.token_id;
          session = ctx.client.withBearer(credential.secret_key, 'SESSION_TOKEN');
          // PRIVATE visibility: a member-owned account is reachable only in a
          // private session. A shared session must never hand a teammate's
          // personal mailbox to whoever opens it.
          await db.query(
            `INSERT INTO kortix.project_sessions
               (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
             VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'private')`,
            [sessionId, team.id, p.id, ownerUserId],
          );
          await db.query(
            `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
             VALUES ($1::uuid, $1, $2, $3, 'active')`,
            [sessionId, team.id, p.id],
          );
          await db.query(
            `UPDATE kortix.account_tokens
               SET account_id = $2, user_id = $3, project_id = $4, session_id = $5, agent_grant = $6::jsonb
             WHERE token_id = $1`,
            [
              tokenId,
              team.id,
              ownerUserId,
              p.id,
              sessionId,
              JSON.stringify({ agent: 'kortix', connectors: 'all', permissions: [], env: [] }),
            ],
          );
          // `auth: {type:'none'}` is the fixture's whole point: the connector
          // needs no credential, so every ACTIVE connection on it counts as
          // connected and the list is decided purely by the access rule.
          //
          // `http`, not `mcp`, on purpose: pinning a project-owned MCP account
          // re-materializes the project catalog from the manifest (a full sync
          // that prunes a DB-only connector together with every account on it,
          // and that marks an unreachable MCP URL `error`, which empties the
          // list). An `http` connector is inert on pin, so the fixture row
          // survives exactly as seeded. Found 2026-09-17: `default_account`
          // read back null after the PUT.
          const connector = await db.query<{ connector_id: string }>(
            `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
             VALUES ($1, $2, $3, 'KE2E Accounts', 'http', $4::jsonb, 'active') RETURNING connector_id`,
            [
              team.id,
              p.id,
              slug,
              JSON.stringify({ base_url: 'https://ke2e.kortix.test', auth: { type: 'none' } }),
            ],
          );
          connectorId = connector.rows[0]?.connector_id ?? '';
          if (!connectorId) throw new Error('connector fixture was not created');
          const shared = await db.query<{ connection_id: string }>(
            `INSERT INTO kortix.connector_connections
               (account_id, project_id, connector_id, owner_type, label, status, is_default)
             VALUES ($1, $2, $3, 'project', $4, 'active', true) RETURNING connection_id`,
            [team.id, p.id, connectorId, SHARED_DEFAULT],
          );
          sharedDefaultId = shared.rows[0]?.connection_id ?? '';
          await db.query(
            `INSERT INTO kortix.connector_connections
               (account_id, project_id, connector_id, owner_type, label, status, is_default)
             VALUES ($1, $2, $3, 'project', $4, 'active', false)`,
            [team.id, p.id, connectorId, SHARED_SECOND],
          );
          const mine = await db.query<{ connection_id: string }>(
            `INSERT INTO kortix.connector_connections
               (account_id, project_id, connector_id, owner_type, owner_id, label, status, is_default)
             VALUES ($1, $2, $3, 'member', $4, $5, 'active', false) RETURNING connection_id`,
            [team.id, p.id, connectorId, ownerUserId, PRIVATE_OWN],
          );
          privateOwnId = mine.rows[0]?.connection_id ?? '';
          if (!sharedDefaultId || !privateOwnId) throw new Error('connection fixtures incomplete');
        },
      );

      await ctx.step(
        'the session lists all three accounts, each shared group default-first',
        async () => {
          const r = await readAccounts(session);
          r.status(200).body().has('$.connector', slug);
          const accounts = r.json<{
            accounts: Array<{
              connection_id: string;
              label: string;
              owner_type: string;
              is_default: boolean;
            }>;
          }>().accounts;
          const labels = accounts.map((a) => a.label);
          for (const label of [SHARED_DEFAULT, SHARED_SECOND, PRIVATE_OWN]) {
            if (!labels.includes(label)) {
              throw new Error(`accounts omitted "${label}": ${labels.join(', ')}`);
            }
          }
          // Only the order WITHIN the shared group is asserted. Which group
          // comes first is a resolution policy, and pinning it here would make
          // this flow re-litigate it.
          if (labels.indexOf(SHARED_DEFAULT) > labels.indexOf(SHARED_SECOND)) {
            throw new Error(`the shared default is not listed first: ${labels.join(', ')}`);
          }
          const shared = accounts.find((a) => a.label === SHARED_DEFAULT);
          if (shared?.connection_id !== sharedDefaultId || shared.owner_type !== 'project') {
            throw new Error(`shared default row is wrong: ${JSON.stringify(shared)}`);
          }
          if (shared.is_default !== true) {
            throw new Error('the shared default is not marked default');
          }
          const own = accounts.find((a) => a.label === PRIVATE_OWN);
          // Reachable by MEMBERSHIP of the row, not by a connector-level mode.
          if (own?.connection_id !== privateOwnId || own.owner_type !== 'member') {
            throw new Error(`the caller's own account is missing or mislabeled: ${JSON.stringify(own)}`);
          }
        },
      );

      await ctx.step('the human who owns the private account reads the same list', async () => {
        // The dashboard JWT carries no session. It is the surface behind
        // `kortix connectors accounts`, and it has to agree with what the agent
        // sees or `--account <label>` is a guess.
        const r = await readAccounts(ctx.client.as(ctx.P.OWNER));
        r.status(200);
        const labels = r
          .json<{ accounts: Array<{ label: string }> }>()
          .accounts.map((a) => a.label);
        for (const label of [SHARED_DEFAULT, SHARED_SECOND, PRIVATE_OWN]) {
          if (!labels.includes(label)) {
            throw new Error(`the human's list omitted "${label}": ${labels.join(', ')}`);
          }
        }
      });

      await ctx.step(
        'a call naming an account that does not exist is DENIED and told what was available',
        async () => {
          const r = await session.post(
            '/v1/connectors/projects/:projectId/call',
            { connector: slug, action: 'anything', args: {}, account: 'nope' },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
          // Never a silent substitution. Running the wrong mailbox because the
          // named one did not resolve is the worst outcome available here.
          r.status(403)
            .body()
            .has('$.ok', false)
            .has('$.reason', 'connector_not_connected')
            .has('$.requested_account', 'nope')
            .exists('$.hint');
          const available = r.json<{ available_accounts?: string[] }>().available_accounts ?? [];
          if (!available.includes(SHARED_DEFAULT)) {
            throw new Error(`the denial did not name the reachable accounts: ${r.text()}`);
          }
        },
      );

      await ctx.step(
        'several reachable accounts, none named, none pinned → 403 account_required naming every one',
        async () => {
          // Unpin the seeded shared default. Nothing is pinned now — 3
          // reachable accounts (2 shared, 1 private) and no way to pick one
          // without guessing.
          await db.query(
            `UPDATE kortix.connector_connections SET is_default = false WHERE connection_id = $1`,
            [sharedDefaultId],
          );
          const denied = await session.post(
            '/v1/connectors/projects/:projectId/call',
            { connector: slug, action: 'anything', args: {} },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
          denied
            .status(403)
            .body()
            .has('$.ok', false)
            .has('$.reason', 'account_required')
            .has('$.default_account', null)
            .exists('$.hint');
          const namedInDenial = denied.json<{ available_accounts?: string[] }>().available_accounts ?? [];
          for (const label of [SHARED_DEFAULT, SHARED_SECOND, PRIVATE_OWN]) {
            if (!namedInDenial.includes(label)) {
              throw new Error(`account_required did not name "${label}": ${denied.text()}`);
            }
          }
          const unpinnedList = await readAccounts(session);
          unpinnedList.status(200).body().has('$.default_account', null);

          // Pin one. That is the deliberate choice the rule asks for.
          const pinned = await ctx.client.as(ctx.P.OWNER).put(
            '/v1/projects/:projectId/connections/:connectionId/default',
            {},
            { params: { projectId: p.id, connectionId: sharedDefaultId } },
          );
          pinned.status(200);
          const pinnedList = await readAccounts(session);
          pinnedList.status(200).body().has('$.default_account', SHARED_DEFAULT);

          // The unnamed call now resolves the pinned account and clears the
          // account-resolution gate entirely — it advances to action lookup,
          // which is the only thing left to deny for a made-up action path on
          // this fixture's connector (no real action is registered on it).
          // `action_not_found` (not `account_required`) is exactly the proof
          // that account resolution succeeded and the call ran as the pinned
          // account, not a guess.
          const resolved = await session.post(
            '/v1/connectors/projects/:projectId/call',
            { connector: slug, action: 'anything', args: {} },
            { params: { projectId: p.id }, timeoutMs: 60_000 },
          );
          resolved.status(404).body().has('$.ok', false).has('$.reason', 'action_not_found');
        },
      );

      await ctx.step(
        'narrowing agents.kortix.connectors denies the accounts list itself → 403 connector_not_assigned',
        async () => {
          const narrowed = await declareAgent(['stripe']);
          narrowed.status(200);
          const r = await readAccounts(session);
          // Same gate as `/call`, so the list can never show an account the
          // next call would refuse.
          r.status(403).body().has('$.reason', 'connector_not_assigned').has('$.connector', slug);
        },
      );
    } finally {
      await db
        .query(`DELETE FROM kortix.connector_connections WHERE connector_id = $1`, [connectorId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.connectors WHERE connector_id = $1`, [connectorId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.account_tokens WHERE token_id = $1`, [tokenId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.session_sandboxes WHERE session_id = $1`, [sessionId])
        .catch(() => undefined);
      await db
        .query(`DELETE FROM kortix.project_sessions WHERE session_id = $1`, [sessionId])
        .catch(() => undefined);
      await db.end().catch(() => undefined);
    }
  },
);

// ── CONN-ATT-1 — a staged file reaches a Microsoft Graph-shaped OpenAPI call ──
// A customer's agent could not attach a PDF to Graph `sendMail` through an
// OpenAPI connector. This flow stages a synthetic PDF through the real upload
// route, references it as `{"$kortix_attachment": id}` in the nested
// `body.message.attachments`, and calls the real gateway. On the local target
// a Graph-strict echo upstream (one `application/json` header, a JSON object
// body, else Graph's 400) proves the bytes arrive byte for byte. Deployed
// targets cannot reach a runner-local upstream, so they prove the staging
// contract and the refusals, which need no upstream.
flow(
  'CONN-ATT-1',
  {
    domain: 'connectors',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [
      'POST /v1/connectors/projects/:projectId/attachments',
      'POST /v1/connectors/projects/:projectId/call',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const { createHash } = await import('node:crypto');
    const { createServer } = await import('node:http');
    const { Client: PgClient } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new PgClient({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });

    // Synthetic ~300 KB PDF with every byte value.
    const pdf = new Uint8Array(300_000);
    pdf.set(new TextEncoder().encode('%PDF-1.7\n'));
    for (let i = 9; i < pdf.length; i++) pdf[i] = (i * 31) % 256;
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

    const received: Array<{ contentTypes: string[]; body: string }> = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const raw = req.headers['content-type'];
        const contentTypes = raw === undefined ? [] : String(raw).split(/,\s*/);
        received.push({ contentTypes, body });
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        const ok =
          contentTypes.length === 1 &&
          contentTypes[0] === 'application/json' &&
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed);
        res.writeHead(ok ? 202 : 400, { 'content-type': 'application/json' });
        res.end(
          ok
            ? ''
            : JSON.stringify({
                error: {
                  code: 'BadRequest',
                  message:
                    'Unable to read JSON request payload. Please ensure Content-Type header is set and payload is of valid JSON format.',
                },
              }),
        );
      });
    });
    const port = await new Promise<number>((resolve) =>
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port)),
    );

    const slug = `ke2e-graph-${Date.now().toString(36)}`;
    const itemSchema = {
      type: 'object',
      properties: {
        '@odata.type': { type: 'string' },
        name: { type: 'string' },
        contentType: { type: 'string' },
        contentBytes: { type: 'string', format: 'base64url' },
      },
    };
    const inputSchema = {
      type: 'object',
      properties: {
        user: { type: 'string', 'x-in': 'path' },
        body: {
          type: 'object',
          properties: {
            message: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                toRecipients: { type: 'array' },
                attachments: { type: 'array', items: itemSchema },
              },
            },
            saveToSentItems: { type: 'boolean' },
          },
        },
        files: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
      },
    };
    const upload = (bytes: Uint8Array, filename: string, connector: string | null) =>
      ctx.client.as(ctx.P.OWNER).post('/v1/connectors/projects/:projectId/attachments', bytes, {
        params: { projectId: p.id },
        raw: true,
        headers: {
          'Content-Type': 'application/pdf',
          'X-Kortix-Attachment-Filename': encodeURIComponent(filename),
          ...(connector ? { 'X-Kortix-Attachment-Connector': connector } : {}),
        },
        timeoutMs: 60_000,
      });
    const call = (args: Record<string, unknown>) =>
      ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/call',
          { connector: slug, action: 'sendmail', args },
          { params: { projectId: p.id }, timeoutMs: 60_000 },
        );
    const mail = (attachments: unknown[]) => ({
      user: 'sender@example.com',
      body: {
        message: {
          subject: 'CONN-ATT-1 report',
          toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
          attachments,
        },
        saveToSentItems: true,
      },
    });

    try {
      await db.connect();
      await ctx.step('seed an OpenAPI connector shaped like Graph sendMail, with its default connection', async () => {
        const connector = await db.query<{ connector_id: string }>(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, $3, 'KE2E Graph', 'openapi', $4::jsonb, 'active') RETURNING connector_id`,
          [team.id, p.id, slug, JSON.stringify({ auth: { type: 'none' } })],
        );
        const connectorId = connector.rows[0]?.connector_id;
        if (!connectorId) throw new Error('connector insert returned no id');
        await db.query(
          `INSERT INTO kortix.connector_connections (account_id, project_id, connector_id, owner_type, label, status, is_default, metadata)
           VALUES ($1, $2, $3, 'project', 'KE2E Graph', 'active', true, $4::jsonb)`,
          [team.id, p.id, connectorId, JSON.stringify({ provider: 'openapi', connector_slug: slug })],
        );
        await db.query(
          `INSERT INTO kortix.connector_actions (connector_id, path, name, description, input_schema, risk, binding)
           VALUES ($1, 'sendmail', 'sendMail', 'Send mail', $2::jsonb, 'write', $3::jsonb)`,
          [
            connectorId,
            JSON.stringify(inputSchema),
            JSON.stringify({
              kind: 'openapi',
              method: 'POST',
              path: '/users/{user}/sendMail',
              server: `http://127.0.0.1:${port}/v1.0`,
            }),
          ],
        );
      });

      let ref: { $kortix_attachment: string } | null = null;
      await ctx.step('upload for the connector → 201 with a $kortix_attachment ref', async () => {
        const r = await upload(pdf, 'weekly report.pdf', slug);
        r.status(201)
          .body()
          .has('$.filename', 'weekly report.pdf')
          .has('$.content_type', 'application/pdf')
          .has('$.size', pdf.byteLength);
        const body = r.json<{ attachment_id: string; ref: { $kortix_attachment: string } }>();
        if (body.ref?.$kortix_attachment !== body.attachment_id) {
          throw new Error(`ref does not name the staged file: ${r.text()}`);
        }
        ref = body.ref;
      });

      await ctx.step('an item shape the gateway does not know is refused and names the fix', async () => {
        const r = await call({ ...mail([]), files: [ref] });
        r.status(500).body().has('$.status', 'error');
        const reason = r.json<{ reason: string }>().reason;
        if (!reason.startsWith('attachment_item_shape_unknown: files items declare {url}')) {
          throw new Error(`unexpected refusal: ${reason}`);
        }
      });

      await ctx.step('a malformed reference is refused before any upstream request', async () => {
        const before = received.length;
        const r = await call(mail([{ $kortix_attachment: 42 }]));
        r.status(500);
        if (!r.json<{ reason: string }>().reason.startsWith('attachment_ref_invalid')) {
          throw new Error(`unexpected refusal: ${r.text()}`);
        }
        if (received.length !== before) throw new Error('a malformed reference reached the upstream');
      });

      if (ctx.env.target === 'local') {
        await ctx.step('the refused call released the file; the call delivers a Graph fileAttachment byte for byte', async () => {
          const r = await call(mail([ref]));
          r.status(200).body().has('$.ok', true);
          const hit = received.at(-1);
          if (!hit) throw new Error('the upstream received no request');
          if (hit.contentTypes.join(',') !== 'application/json') {
            throw new Error(`upstream Content-Type: ${JSON.stringify(hit.contentTypes)}`);
          }
          const sent = JSON.parse(hit.body) as {
            message: { attachments: Array<Record<string, string>> };
          };
          const attachment = sent.message.attachments[0]!;
          if (
            attachment['@odata.type'] !== '#microsoft.graph.fileAttachment' ||
            attachment.name !== 'weekly report.pdf' ||
            attachment.contentType !== 'application/pdf'
          ) {
            throw new Error(`wrong attachment item: ${JSON.stringify({ ...attachment, contentBytes: '…' })}`);
          }
          const decoded = new Uint8Array(Buffer.from(attachment.contentBytes!, 'base64'));
          if (sha256(decoded) !== sha256(pdf)) throw new Error('attachment bytes differ from the staged file');
        });

        await ctx.step('a delivered file is single-use: a second call is refused', async () => {
          const r = await call(mail([ref]));
          r.status(500);
          if (!r.json<{ reason: string }>().reason.includes('attachment_already_consumed')) {
            throw new Error(`expected attachment_already_consumed: ${r.text()}`);
          }
        });

        await ctx.step('a JSON-string body reaches the upstream as one JSON object, not a string literal', async () => {
          const r = await call({ user: 'sender@example.com', body: JSON.stringify(mail([]).body) });
          r.status(200).body().has('$.ok', true);
          const hit = received.at(-1)!;
          if (typeof JSON.parse(hit.body) !== 'object') throw new Error(`double-encoded body: ${hit.body.slice(0, 80)}`);
        });

        await ctx.step('the audit row records the attachment count, never the bytes', async () => {
          const rows = await db.query<{ result_summary: Record<string, unknown> | null; request_digest: string | null }>(
            `SELECT result_summary, request_digest FROM kortix.connector_calls
              WHERE project_id = $1 AND action_path = $2 AND status = 'ok'`,
            [p.id, `${slug}.sendmail`],
          );
          const withFile = rows.rows.find((row) => row.result_summary?.attachment_count === 1);
          if (!withFile) throw new Error(`no ok audit row with attachment_count 1: ${JSON.stringify(rows.rows)}`);
          const fingerprint = Buffer.from(pdf.subarray(1_000, 1_096)).toString('base64');
          if (JSON.stringify(rows.rows).includes(fingerprint)) throw new Error('file bytes reached the audit table');
        });
      }
    } finally {
      upstream.close();
      await db.query(`DELETE FROM kortix.connectors WHERE project_id = $1 AND slug = $2`, [p.id, slug]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);

// ── CONN-EGRESS-1 — a connector reaches public endpoints only ────────────────
// Connector endpoints come from project configuration (`base_url`, an OpenAPI
// `servers[0].url`, an MCP URL). Sync refuses a literal private host, and the
// gateway resolves and checks the target of every call and every redirect hop.
// The local stack allows its own loopback upstream (127.0.0.1) and nothing else,
// so the redirect steps run on the local target only.
flow(
  'CONN-EGRESS-1',
  {
    domain: 'connectors',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [
      'POST /v1/connectors/projects/:projectId/connectors',
      'DELETE /v1/connectors/projects/:projectId/connectors/:slug',
      'POST /v1/connectors/projects/:projectId/call',
    ],
  },
  async (ctx) => {
    // The manifest step needs a Git-backed project. The seeded connectors live
    // in a database-only project: it has no kortix.yaml, so no sync (this
    // flow's or a parallel account-wide reconcile) removes them as undeclared.
    const p = await ctx.fixtures.project({ managedGit: true });
    const seeded = await ctx.fixtures.project();
    const { createServer } = await import('node:http');
    const { Client: PgClient } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new PgClient({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
    const stamp = Date.now().toString(36);
    const yamlSlug = `ke2e-egress-yaml-${stamp}`;
    const seededSlug = `ke2e-egress-db-${stamp}`;

    const hits: string[] = [];
    let redirectTo = '';
    const upstream = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (redirectTo) {
        res.writeHead(302, { location: redirectTo });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reached: true }));
    });
    const port = await new Promise<number>((resolve) =>
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port)),
    );
    const call = (slug: string) =>
      ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/connectors/projects/:projectId/call',
          { connector: slug, action: 'ping', args: {} },
          { params: { projectId: seeded.id }, timeoutMs: 60_000 },
        );
    let accountId = '';
    const seed = async (baseUrl: string) => {
      if (!accountId) {
        const owner = await db.query<{ account_id: string }>(
          `SELECT account_id FROM kortix.projects WHERE project_id = $1`,
          [seeded.id],
        );
        accountId = owner.rows[0]?.account_id ?? '';
        if (!accountId) throw new Error('project has no account');
      }
      await db.query(`DELETE FROM kortix.connectors WHERE project_id = $1 AND slug = $2`, [seeded.id, seededSlug]);
      const connector = await db.query<{ connector_id: string }>(
        `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
         VALUES ($1, $2, $3, 'KE2E egress', 'http', $4::jsonb, 'active') RETURNING connector_id`,
        [accountId, seeded.id, seededSlug, JSON.stringify({ baseUrl, auth: { type: 'none' } })],
      );
      const connectorId = connector.rows[0]?.connector_id;
      if (!connectorId) throw new Error('connector insert returned no id');
      await db.query(
        `INSERT INTO kortix.connector_connections (account_id, project_id, connector_id, owner_type, label, status, is_default, metadata)
         VALUES ($1, $2, $3, 'project', 'KE2E egress', 'active', true, $4::jsonb)`,
        [accountId, seeded.id, connectorId, JSON.stringify({ provider: 'http', connector_slug: seededSlug })],
      );
      await db.query(
        `INSERT INTO kortix.connector_actions (connector_id, path, name, description, input_schema, risk, binding)
         VALUES ($1, 'ping', 'ping', 'Ping', '{"type":"object"}'::jsonb, 'read', $2::jsonb)`,
        [connectorId, JSON.stringify({ kind: 'http', method: 'GET', path: '/ping' })],
      );
    };
    const expectBlocked = (r: Awaited<ReturnType<typeof call>>) => {
      r.status(500).body().has('$.status', 'error');
      const reason = r.json<{ reason: string }>().reason;
      if (!reason.startsWith('connector_egress_blocked')) {
        throw new Error(`expected connector_egress_blocked, got: ${reason}`);
      }
    };

    try {
      await db.connect();
      await ctx.step('adding an http connector whose base_url is a private address reports the endpoint as refused', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/connectors/projects/:projectId/connectors',
          { slug: yamlSlug, provider: 'http', baseUrl: 'http://10.255.255.1:8080', auth: { type: 'none' } },
          { params: { projectId: p.id }, timeoutMs: 60_000 },
        );
        r.status(200).body().has('$.ok', true);
        const errors = r.json<{ sync?: { errors?: Array<{ slug: string; error: string }> } }>().sync?.errors ?? [];
        const mine = errors.find((e) => e.slug === yamlSlug);
        if (!mine || !mine.error.includes('base_url must be a public host')) {
          throw new Error(`sync did not refuse the private base_url: ${JSON.stringify(errors)}`);
        }
        // Another sync of the same account (a machine or channel reconcile from
        // a parallel flow) can own the write; it lands within a few seconds.
        let rows: Array<{ status: string; actions: string }> = [];
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const row = await db.query<{ status: string; actions: string }>(
            `SELECT c.status, (SELECT count(*) FROM kortix.connector_actions a WHERE a.connector_id = c.connector_id)::text AS actions
               FROM kortix.connectors c WHERE c.project_id = $1 AND c.slug = $2`,
            [p.id, yamlSlug],
          );
          rows = row.rows;
          if (rows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (rows[0]?.status !== 'error' || rows[0]?.actions !== '0') {
          throw new Error(`connector row is callable: ${JSON.stringify(rows)}`);
        }
      });

      await ctx.step('a stored private base_url is refused at call time before any request', async () => {
        await seed('http://10.255.255.1:8080');
        expectBlocked(await call(seededSlug));
      });

      await ctx.step('a stored link-local metadata address is refused at call time', async () => {
        await seed('http://169.254.169.254/latest');
        expectBlocked(await call(seededSlug));
      });

      if (ctx.env.target === 'local') {
        await ctx.step('an allowed upstream answers the call and its response comes back', async () => {
          redirectTo = '';
          await seed(`http://127.0.0.1:${port}`);
          const before = hits.length;
          const r = await call(seededSlug);
          r.status(200).body().has('$.ok', true).has('$.data.reached', true);
          if (hits.length !== before + 1) throw new Error(`upstream saw ${hits.length - before} requests`);
        });

        await ctx.step('a redirect from the allowed upstream to a metadata address is refused, not followed', async () => {
          redirectTo = 'http://169.254.169.254/latest/meta-data/';
          const before = hits.length;
          expectBlocked(await call(seededSlug));
          if (hits.length !== before + 1) throw new Error(`upstream saw ${hits.length - before} requests`);
        });

        await ctx.step('a redirect to another loopback port is refused too: only the listed host is exempt', async () => {
          redirectTo = `http://localhost:${port}/ping`;
          expectBlocked(await call(seededSlug));
        });
      }

      await ctx.step('delete the manifest connector → 200', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .del('/v1/connectors/projects/:projectId/connectors/:slug', { params: { projectId: p.id, slug: yamlSlug } });
        r.status(200);
      });
    } finally {
      upstream.close();
      await db.query(`DELETE FROM kortix.connectors WHERE project_id = $1 AND slug = $2`, [seeded.id, seededSlug]).catch(() => {});
      await db.query(`DELETE FROM kortix.connectors WHERE project_id = $1 AND slug = $2`, [p.id, yamlSlug]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);
