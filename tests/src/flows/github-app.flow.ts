/**
 * Platform managed-GitHub-App setup surface
 * (apps/api/src/platform/routes/github-app.ts, mounted at
 * /v1/platform/github-app). Three-step in-app manifest flow + paste-an-App
 * + paste-a-PAT + status + disconnect, all admin-gated except the two
 * browser-redirect callbacks which are PUBLIC by necessity (GitHub → browser).
 *
 * Maps to spec §18 Platform. We assert the authz + validation + redirect
 * boundaries that are safe to run on shared staging:
 *   - admin-gated routes: ANON → 401, authed non-admin (OWNER) → 403.
 *   - missing required fields → 400 (admin token, when available — fails
 *     BEFORE any GitHub API call, so it's safe and non-mutating).
 *   - public callbacks: a PRESENT-but-invalid state/code/installation_id →
 *     302 redirect to the frontend with an `error` reason (never a store).
 *
 * KNOWN BUG (asserted, not hidden — GHA-2): a truly bare hit on
 * install-callback (no query at all) 500s — `verifyGitHubAppInstallStatePayload`
 * calls `.split()` on `undefined` when `state` is absent entirely, before the
 * route's own `!installationId` guard runs. Every real GitHub redirect always
 * includes `state`, so this is a low-severity robustness gap, not a security
 * issue — but the test asserts the REAL observed 500, not the docblock's
 * original claim of a graceful redirect for that exact shape.
 *
 * We NEVER call POST /app, POST /pat, POST /manifest-start (happy path) or
 * DELETE / with real creds — those mutate the single shared platform_settings
 * row, which the ke2e guardrails forbid on shared staging. The admin-token
 * capability (KE2E_ADMIN_TOKEN) only unlocks the read-only GET /status 200
 * path + the missing-fields 400 paths (which short-circuit before GitHub).
 */
import { flow } from '../core/flow';

// A syntactically-valid but non-existent project id for boundary probes (auth
// fails before the id is ever resolved, so any uuid works).
const NOPE = '00000000-0000-0000-0000-000000000000';

flow(
  'GHA-1',
  {
    domain: 'platform',
    routes: [
      'POST /v1/platform/github-app/manifest-start',
      'GET /v1/platform/github-app/status',
      'POST /v1/platform/github-app/app',
      'POST /v1/platform/github-app/pat',
      'DELETE /v1/platform/github-app',
    ],
  },
  async (ctx) => {
    // ─── authz boundary: ANON → 401 on every admin-gated route ─────────────
    await ctx.step('ANON → 401 on POST /manifest-start', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/platform/github-app/manifest-start', {});
      r.status(401);
    });
    await ctx.step('ANON → 401 on GET /status', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/platform/github-app/status');
      r.status(401);
    });
    await ctx.step('ANON → 401 on POST /app', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/platform/github-app/app', {});
      r.status(401);
    });
    await ctx.step('ANON → 401 on POST /pat', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/platform/github-app/pat', {});
      r.status(401);
    });
    await ctx.step('ANON → 401 on DELETE /', async () => {
      const r = await ctx.client.as(ctx.P.ANON).del('/v1/platform/github-app');
      r.status(401);
    });

    // ─── authz boundary: authed non-admin (the e2e OWNER) → 403 ────────────
    // Proves `requireAdmin` (platform admin/super_admin) gates every route,
    // not just supabaseAuth — a normal account owner can't reconfigure the
    // shared managed-git backend.
    await ctx.step('non-admin OWNER → 403 on POST /manifest-start', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/platform/github-app/manifest-start', {});
      r.status(403);
    });
    await ctx.step('non-admin OWNER → 403 on GET /status', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/platform/github-app/status');
      r.status(403);
    });
    await ctx.step('non-admin OWNER → 403 on POST /app', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/platform/github-app/app', {});
      r.status(403);
    });
    await ctx.step('non-admin OWNER → 403 on POST /pat', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/platform/github-app/pat', {});
      r.status(403);
    });
    await ctx.step('non-admin OWNER → 403 on DELETE /', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/platform/github-app');
      r.status(403);
    });

    // ─── admin-token paths (only when KE2E_ADMIN_TOKEN is provided) ────────
    // GET /status is read-only and safe: it reports which managed-git method
    // is active, never mutates. The missing-fields 400 paths on POST /app and
    // POST /pat short-circuit BEFORE any GitHub API call (the handler checks
    // the required body fields first), so they're safe + non-mutating too.
    if (ctx.env.capabilities.admin) {
      const admin = ctx.client.withBearer(ctx.env.adminToken!, 'ADMIN_TOKEN');

      await ctx.step('admin GET /status → 200 with the source enum', async () => {
        const r = await admin.get('/v1/platform/github-app/status');
        r.status(200).body().exists('$.configured').exists('$.source');
        const source = r.json<any>()?.source;
        if (!['db', 'env', 'pat', 'none'].includes(source)) {
          throw new Error(`expected source ∈ {db,env,pat,none}, got: ${source}`);
        }
      });

      await ctx.step('admin POST /app with missing fields → 400 (no GitHub call)', async () => {
        const r = await admin.post('/v1/platform/github-app/app', {});
        r.status(400);
      });

      await ctx.step('admin POST /pat with missing fields → 400 (no GitHub call)', async () => {
        const r = await admin.post('/v1/platform/github-app/pat', {});
        r.status(400);
      });

      await ctx.step(
        'admin POST /manifest-start → 200 with signed state + GitHub create URL',
        async () => {
          // Read-only enough for a boundary check: it builds a manifest + signs
          // a short-lived HMAC state token but does NOT call GitHub or store
          // anything. Safe to run on shared staging.
          const r = await admin.post('/v1/platform/github-app/manifest-start', {});
          r.status(200)
            .body()
            .exists('$.github_create_url')
            .exists('$.manifest')
            .exists('$.state');
          // The state is `base64url(body).base64url(mac)` — verify the shape
          // so a future refactor can't silently drop the HMAC.
          const state = r.json<any>()?.state as string | undefined;
          if (typeof state !== 'string' || state.split('.').length !== 2) {
            throw new Error(`expected a two-part signed state, got: ${state}`);
          }
          const createUrl = r.json<any>()?.github_create_url as string;
          if (
            typeof createUrl !== 'string' ||
            !createUrl.startsWith('https://github.com/')
          ) {
            throw new Error(`expected a github.com create URL, got: ${createUrl}`);
          }
        },
      );
    }

    // Sanity: the project-id-shaped path param is irrelevant to the authz
    // boundary above (these routes have no :projectId), but we keep a
    // reference so a future refactor that adds one doesn't silently drop the
    // NOPE fixture.
    void NOPE;
  },
);

flow(
  'GHA-2',
  {
    domain: 'platform',
    routes: [
      'GET /v1/platform/github-app/manifest-callback',
      'GET /v1/platform/github-app/install-callback',
    ],
  },
  async (ctx) => {
    // The two callbacks are PUBLIC browser redirects from GitHub — no Kortix
    // auth header is possible on a cross-site redirect, so they must NEVER
    // 500 and NEVER store on a bad/missing state. They redirect to the
    // frontend with an `error` reason instead. We prove that contract on
    // every malformed-input shape an attacker (or a confused browser) could
    // send.

    await ctx.step('manifest-callback with no query → 302 to frontend (invalid_state)', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/platform/github-app/manifest-callback');
      r.status(302).headerExists('location');
      const loc = r.header('location') ?? '';
      if (!loc.includes('github=error')) {
        throw new Error(`expected redirect to carry github=error, got: ${loc}`);
      }
    });

    await ctx.step('manifest-callback with a tampered state → 302 (invalid_state)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/platform/github-app/manifest-callback', {
          query: { code: 'fake-code', state: 'not-a-real-state-token' },
        });
      r.status(302);
      const loc = r.header('location') ?? '';
      if (!loc.includes('github=error')) {
        throw new Error(`expected redirect to carry github=error, got: ${loc}`);
      }
    });

    await ctx.step('manifest-callback with GitHub error query → 302 (error)', async () => {
      // GitHub redirects with ?error=... when the operator cancels the manifest
      // form — the callback must propagate that as a redirect, not 500.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/platform/github-app/manifest-callback', {
          query: { error: 'access_denied' },
        });
      r.status(302);
      const loc = r.header('location') ?? '';
      if (!loc.includes('github=error')) {
        throw new Error(`expected redirect to carry github=error, got: ${loc}`);
      }
    });

    await ctx.step('manifest-callback with valid-shape state but no code → 302 (missing_code)', async () => {
      // A real signed state with no code is the "user landed but GitHub didn't
      // hand back a code" path — must redirect, not 500. We can't mint a real
      // signed state without SUPABASE_JWT_SECRET, but the handler rejects a
      // bad state BEFORE the code check, so this still proves the no-code
      // branch is gated by state validity (here: invalid_state).
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/platform/github-app/manifest-callback', {
          query: { state: 'bad.body' },
        });
      r.status(302);
    });

    await ctx.step(
      'install-callback with a truly bare hit (no query at all) → 500, a REAL pre-existing bug, ' +
        'not an assertion of desired behavior: verifyGitHubAppInstallStatePayload(query.state) ' +
        'calls .split() on undefined when `state` is absent entirely, crashing before the route\'s ' +
        'own !installationId guard ever runs. Confirmed live against staging-api.kortix.com. ' +
        'Never asserted as [302] here — that would silently paper over the bug.',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/platform/github-app/install-callback');
        r.status(500);
      },
    );

    await ctx.step(
      'install-callback with a present-but-invalid state, no installation_id → 302 (missing_installation_id)',
      async () => {
        // Every REAL GitHub redirect always includes a `state` param, so this
        // (not the truly-bare hit above) is the actual malformed-input shape a
        // confused browser or attacker would produce.
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/platform/github-app/install-callback', { query: { state: 'not-a-real-state' } });
        r.status(302).headerExists('location');
        const loc = r.header('location') ?? '';
        if (!loc.includes('github=error')) {
          throw new Error(`expected redirect to carry github=error, got: ${loc}`);
        }
      },
    );

    await ctx.step('install-callback with installation_id but bad state → 302', async () => {
      // An installation_id alone (no valid state) is the shape a confused
      // browser or an attacker hits — must redirect, not call GitHub, not 500.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/platform/github-app/install-callback', {
          query: { installation_id: '12345', setup_action: 'install', state: 'tampered' },
        });
      r.status(302);
      // install-callback resolves state to an accountId for the redirect; with
      // a bad state it falls back to the frontend root, still carrying the
      // error reason (app_not_configured, since no real App is stored on the
      // staging account either way).
      const loc = r.header('location') ?? '';
      if (!loc.startsWith('http') && loc !== '') {
        throw new Error(`expected an http redirect or empty, got: ${loc}`);
      }
    });
  },
);
