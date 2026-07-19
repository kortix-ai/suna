/**
 * Global marketplace catalog (apps/api/src/marketplace/index.ts +
 * catalog.ts), mounted at /v1/marketplace — a READ-ONLY browse of the
 * installable-item catalog (skills/agents/projects/templates), distinct from
 * the per-project install engine deleted by the marketplace-as-projects
 * rewrite (docs/specs/2026-07-13-marketplace-as-projects.md). `/items*` and
 * `/marketplaces*` are fully public; `/sources` (the "Add a marketplace"
 * config) requires auth to read and admin to mutate — except a curated
 * FEATURED address, which any signed-in user may add (see the route's own
 * comment in index.ts).
 *
 * Also covers the ONE surviving project-scoped marketplace route —
 * `POST /v1/projects/:projectId/marketplace/install-session`, the
 * agent-driven replacement for the deleted deterministic install engine
 * (apps/api/src/projects/routes/r10.ts). It kicks off a real session/agent
 * once past validation, so — same convention as PROJ-13's OAuth `start` in
 * projects-misc.flow.ts — we assert the request-validation boundary only,
 * never drive the full flow.
 */
import { flow } from '../core/flow';

// A syntactically-valid but non-existent id for boundary probes.
const NOPE = '00000000-0000-4000-a000-000000000000';
// A stable, real catalog item shipped from packages/starter/templates — part
// of the product's own source tree, not user-generated content, so safe to
// pin as a fixture id.
const KNOWN_ITEM_ID = 'kortix-starter:access-policy-skill';
const KNOWN_ITEM_FILE_TARGET = '@skills/access-policy/SKILL.md';
// One of the curated, vetted, public, read-only FEATURED_MARKETPLACES
// addresses (apps/api/src/marketplace/catalog.ts) — any signed-in user may
// add one of these without admin (see POST /sources's own comment), so it's
// the only address a non-admin OWNER can safely create+clean up for real.
const FEATURED_ADDRESS = 'anthropics/skills';

// ─── COVB-8 — GET /v1/marketplace/items ───────────────────────────────────
flow('COVB-8', { domain: 'marketplace', routes: ['GET /v1/marketplace/items'] }, async (ctx) => {
  await ctx.step('public catalog list (no auth) → 200', async () => {
    const r = await ctx.client.as(ctx.P.ANON).get('/v1/marketplace/items');
    r.status(200).body().exists('$.items').exists('$.total').exists('$.hasMore');
  });
  await ctx.step('paginated (limit/offset) → 200, respects limit', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .get('/v1/marketplace/items', { query: { limit: '2', offset: '0' } });
    r.status(200);
    const body = r.json();
    if (!Array.isArray(body.items) || body.items.length > 2) {
      throw new Error(`expected <=2 items with limit=2, got ${body.items?.length}`);
    }
  });
  await ctx.step('filtered by query text → 200, matches', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .get('/v1/marketplace/items', { query: { query: 'access-policy' } });
    r.status(200);
    const body = r.json();
    if (!Array.isArray(body.items) || !body.items.some((it: any) => it.id === KNOWN_ITEM_ID)) {
      throw new Error(`expected "${KNOWN_ITEM_ID}" in query-filtered results`);
    }
  });
});

// ─── COVB-9 — GET /v1/marketplace/items/:id ───────────────────────────────
flow(
  'COVB-9',
  { domain: 'marketplace', routes: ['GET /v1/marketplace/items/:id'] },
  async (ctx) => {
    await ctx.step('known item → 200 real shape', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/marketplace/items/:id', { params: { id: KNOWN_ITEM_ID } });
      r.status(200)
        .body()
        .has('$.id', KNOWN_ITEM_ID)
        .exists('$.title')
        .exists('$.files')
        .exists('$.readme');
    });
    await ctx.step('unknown item → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/marketplace/items/:id', { params: { id: 'nope-' + NOPE } });
      r.status(404);
    });
  },
);

// ─── COVB-10 — GET /v1/marketplace/items/:id/file ─────────────────────────
flow(
  'COVB-10',
  { domain: 'marketplace', routes: ['GET /v1/marketplace/items/:id/file'] },
  async (ctx) => {
    await ctx.step('known item + file target → 200 content', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/marketplace/items/:id/file', {
          params: { id: KNOWN_ITEM_ID },
          query: { path: KNOWN_ITEM_FILE_TARGET },
        });
      r.status(200).body().has('$.target', KNOWN_ITEM_FILE_TARGET).exists('$.content');
    });
    await ctx.step('missing path query → 400 (zod validation)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/marketplace/items/:id/file', { params: { id: KNOWN_ITEM_ID } });
      r.status(400);
    });
    await ctx.step('unknown file target on a known item → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/marketplace/items/:id/file', {
          params: { id: KNOWN_ITEM_ID },
          query: { path: 'nope/does-not-exist.md' },
        });
      r.status(404);
    });
  },
);

// ─── COVB-11 — GET /v1/marketplace/marketplaces ───────────────────────────
flow(
  'COVB-11',
  { domain: 'marketplace', routes: ['GET /v1/marketplace/marketplaces'] },
  async (ctx) => {
    await ctx.step('public list of distinct marketplaces (no auth) → 200', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/marketplace/marketplaces');
      r.status(200).body().exists('$.marketplaces');
      const body = r.json();
      if (
        !Array.isArray(body.marketplaces) ||
        !body.marketplaces.some((m: any) => m.id === 'kortix')
      ) {
        throw new Error('expected the built-in "kortix" marketplace in the list');
      }
    });
  },
);

// ─── COVB-12 — GET /v1/marketplace/marketplaces/featured ──────────────────
flow(
  'COVB-12',
  { domain: 'marketplace', routes: ['GET /v1/marketplace/marketplaces/featured'] },
  async (ctx) => {
    await ctx.step('public curated featured list (no auth) → 200', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/marketplace/marketplaces/featured');
      r.status(200).body().exists('$.featured');
      const body = r.json();
      if (
        !Array.isArray(body.featured) ||
        !body.featured.some((f: any) => f.address === FEATURED_ADDRESS)
      ) {
        throw new Error(`expected "${FEATURED_ADDRESS}" in the featured list`);
      }
    });
  },
);

// ─── COVB-13 — GET /v1/marketplace/sources ─────────────────────────────────
flow('COVB-13', { domain: 'marketplace', routes: ['GET /v1/marketplace/sources'] }, async (ctx) => {
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client.as(ctx.P.ANON).get('/v1/marketplace/sources');
    r.status(401);
  });
  await ctx.step('any authenticated user (non-admin) reads sources → 200', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/marketplace/sources');
    r.status(200).body().exists('$.sources');
  });
});

// ─── COVB-14 — POST /v1/marketplace/sources + DELETE /v1/marketplace/sources/:id ─
// Adding an ARBITRARY source is admin-only; adding one of the curated
// FEATURED_MARKETPLACES addresses is allowed for any signed-in user (see
// index.ts's own comment on this exception). DELETE is unconditionally
// admin-only regardless of address. We assert every boundary always; the
// real create+delete round trip only runs when we hold an admin token (so
// cleanup is guaranteed) — creating without the ability to clean up would
// leak a real row on shared staging.
flow(
  'COVB-14',
  {
    domain: 'marketplace',
    routes: ['POST /v1/marketplace/sources', 'DELETE /v1/marketplace/sources/:id'],
  },
  async (ctx) => {
    await ctx.step('POST ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/marketplace/sources', { address: FEATURED_ADDRESS });
      r.status(401);
    });
    await ctx.step('POST non-admin OWNER, arbitrary (non-featured) address → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/marketplace/sources', {
          address: 'https://example.com/not-featured-registry.json',
        });
      r.status(403);
    });
    await ctx.step('DELETE ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del('/v1/marketplace/sources/:id', { params: { id: NOPE } });
      r.status(401);
    });
    await ctx.step(
      'DELETE non-admin OWNER → 403 (admin-only regardless of ownership)',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .del('/v1/marketplace/sources/:id', { params: { id: NOPE } });
        r.status(403);
      },
    );

    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, 'ADMIN_TOKEN');
      let createdId: string | undefined;
      try {
        await ctx.step(
          'non-admin OWNER adds a FEATURED address → 200 real create (no admin needed)',
          async () => {
            const r = await ctx.client
              .as(ctx.P.OWNER)
              .post('/v1/marketplace/sources', { address: FEATURED_ADDRESS });
            r.status(200).body().exists('$.source.id');
            createdId = r.json().source.id;
          },
        );
      } finally {
        if (createdId) {
          const id = createdId;
          await ctx.step('admin deletes the source → 200 {ok:true}', async () => {
            const r = await admin.del('/v1/marketplace/sources/:id', { params: { id } });
            r.status(200).body().has('$.ok', true);
          });
          await ctx.step('admin deletes it again → 404 (already gone)', async () => {
            const r = await admin.del('/v1/marketplace/sources/:id', { params: { id } });
            r.status(404);
          });
        }
      }
    }
  },
);

// ─── COVB-15 — POST /v1/projects/:projectId/marketplace/install-session ──
// Agent-driven replacement for the deleted deterministic per-project install
// engine. Validates projectId access + body BEFORE spawning any real
// session/agent (apps/api/src/projects/routes/r10.ts:134-163) — we assert
// that boundary only, matching PROJ-13's convention for similarly heavy
// routes (projects-misc.flow.ts).
flow(
  'COVB-15',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/marketplace/install-session'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { id: KNOWN_ITEM_ID },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
    await ctx.step('unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { id: KNOWN_ITEM_ID },
          { params: { projectId: NOPE } },
        );
      r.status(404);
    });
    await ctx.step("missing id → 400 {error: 'id is required'} (no session spawned)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          {},
          { params: { projectId: p.id } },
        );
      r.status(400).body().has('$.error', 'id is required');
    });
    await ctx.step('unknown id → 400 (no session spawned)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { id: 'nope-' + NOPE },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('NONMEMBER (no write access) → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/marketplace/install-session',
          { id: KNOWN_ITEM_ID },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);
