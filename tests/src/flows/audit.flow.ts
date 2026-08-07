/**
 * Account-scoped audit surface (apps/api/src/accounts/audit.ts, mounted under
 * /v1/accounts). Reads gated on audit.read; webhook CRUD gated on account.write.
 * Uses ctx.fixtures.team() — OWNER is authorized, NONMEMBER → 403. Maps to AUD-*.
 */
import { flow } from '../core/flow';

// ── AUD-1: list audit events ─────────────────────────────────────────────────
flow('AUD-1', { domain: 'audit', routes: ['GET /v1/accounts/:accountId/audit'] }, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  await ctx.step('OWNER lists audit events → 200 with events array', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get('/v1/accounts/:accountId/audit', { params: { accountId: team.id } });
    r.status(200).body().exists('$.events');
  });
  await ctx.step('limit/action filter honored → 200', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
      params: { accountId: team.id },
      query: { limit: '5', action: 'iam.' },
    });
    r.status(200).body().exists('$.events');
  });
  await ctx.step('NONMEMBER → 403', async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .get('/v1/accounts/:accountId/audit', { params: { accountId: team.id } });
    r.status(403);
  });
});

// ── AUD-2: export ────────────────────────────────────────────────────────────
flow(
  'AUD-2',
  { domain: 'audit', routes: ['GET /v1/accounts/:accountId/audit/export'] },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    await ctx.step('export defaults to CSV → 200 text/csv', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/export', { params: { accountId: team.id } });
      r.status(200).headerEquals('content-type', /csv/);
    });
    await ctx.step('export format=jsonl → 200 ndjson', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit/export', {
        params: { accountId: team.id },
        query: { format: 'jsonl' },
      });
      r.status(200).headerEquals('content-type', /ndjson/);
    });
    await ctx.step('invalid format → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit/export', {
        params: { accountId: team.id },
        query: { format: 'xlsx' },
      });
      r.status(400);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/accounts/:accountId/audit/export', { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ── AUD-3: list webhooks + authz boundary ────────────────────────────────────
flow(
  'AUD-3',
  { domain: 'audit', routes: ['GET /v1/accounts/:accountId/audit/webhooks'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step('OWNER lists webhooks → 200 with webhooks array', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(200).body().exists('$.webhooks');
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(403);
    });
  },
);

// ── AUD-4: webhook create → patch → delete lifecycle ─────────────────────────
flow(
  'AUD-4',
  {
    domain: 'audit',
    routes: [
      'POST /v1/accounts/:accountId/audit/webhooks',
      'PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId',
      'DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    let webhookId = '';

    await ctx.step('create webhook → 201, secret revealed once', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: ctx.fixtures.name('hook'), url: 'https://example.com/ke2e-audit' },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists('$.webhook_id').exists('$.secret');
      webhookId = r.json<any>().webhook_id;
    });

    await ctx.step('create with missing url → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: ctx.fixtures.name('hook') },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    await ctx.step('create with bad url scheme → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: ctx.fixtures.name('hook'), url: 'ftp://example.com/x' },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    await ctx.step('NONMEMBER cannot create → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: 'nope', url: 'https://example.com/x' },
          { params: { accountId: team.id } },
        );
      r.status(403);
    });

    await ctx.step('patch: disable webhook → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/audit/webhooks/:webhookId',
          { enabled: false },
          { params: { accountId: team.id, webhookId } },
        );
      r.status(200).body().has('$.enabled', false);
    });

    await ctx.step('patch unknown webhook id → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/audit/webhooks/:webhookId',
          { enabled: true },
          { params: { accountId: team.id, webhookId: '00000000-0000-0000-0000-000000000000' } },
        );
      r.status(404);
    });

    await ctx.step('delete webhook → 200 deleted', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/:accountId/audit/webhooks/:webhookId', {
          params: { accountId: team.id, webhookId },
        });
      r.status(200).body().has('$.deleted', true);
    });

    await ctx.step('delete already-deleted webhook → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/:accountId/audit/webhooks/:webhookId', {
          params: { accountId: team.id, webhookId },
        });
      r.status(404);
    });
  },
);

// ── AUD-5: audit surface edge cases ─────────────────────────────────────────
// Adversarial sweep of boundaries and invariants AUD-1..4 don't yet prove:
//   - ANON → 401 on every audit route (auth boundary, not just NONMEMBER 403)
//   - MEMBER (in-team but lacking audit.read + account.write) → 403 — distinct
//     from NONMEMBER (not in account at all): exercises the role-permission
//     leaf, not just membership
//   - limit clamp semantics: 0/negative → 1, non-numeric → default 50,
//     oversize → MAX_LIMIT 200 (never 400)
//   - cursor pagination round-trip: page 1 → next_cursor → page 2 with no
//     overlapping event_ids (keyset integrity)
//   - export headers (X-Audit-Row-Count, Content-Disposition) + schema rejection
//     for unsupported format casing (CSV is not csv)
//   - webhook create input validation: missing name, oversize name (>128),
//     malformed url, SSRF guard (https://169.254.169.254 cloud metadata)
//   - webhook secret-once invariant: secret revealed on create, NEVER on
//     subsequent GET list or PATCH response (security — prevents leak)
//   - cross-account isolation: webhook from teamA is 404 — not 200, not a
//     leak — when accessed via teamB's path by teamB's owner (the WHERE
//     clause filters by accountId, so a pathspoofed webhookId yields no row)
flow(
  'AUD-5',
  {
    domain: 'audit',
    routes: [
      'GET /v1/accounts/:accountId/audit',
      'GET /v1/accounts/:accountId/audit/export',
      'GET /v1/accounts/:accountId/audit/webhooks',
      'POST /v1/accounts/:accountId/audit/webhooks',
      'PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId',
      'DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId',
    ],
    // 26 steps over an enterprise-team fixture, and every audit list/export
    // query scans a table that now grows with each API request (centralized
    // audit log) — measured 242s on staging against the 120s default.
    timeoutMs: 360_000,
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const member = await team.addMember('member');
    const asMember = ctx.client.as(member);

    // ── ANON boundary: every audit route requires auth → 401 ─────────────
    await ctx.step('ANON list events → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/accounts/:accountId/audit', { params: { accountId: team.id } });
      r.status(401);
    });
    await ctx.step('ANON export → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/accounts/:accountId/audit/export', { params: { accountId: team.id } });
      r.status(401);
    });
    await ctx.step('ANON list webhooks → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(401);
    });
    await ctx.step('ANON create webhook → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: 'x', url: 'https://example.com/x' },
          { params: { accountId: team.id } },
        );
      r.status(401);
    });

    // ── MEMBER boundary: in-team but lacks audit.read + account.write ────
    // Distinct from NONMEMBER (not in account at all): same 403, but this
    // exercises the role-permission leaf (member baseline has no audit.read
    // and no account.write), not just the membership check.
    await ctx.step('MEMBER list events → 403 (no audit.read)', async () => {
      const r = await asMember.get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
      });
      r.status(403);
    });
    await ctx.step('MEMBER export → 403', async () => {
      const r = await asMember.get('/v1/accounts/:accountId/audit/export', {
        params: { accountId: team.id },
      });
      r.status(403);
    });
    await ctx.step('MEMBER list webhooks → 403 (no account.write)', async () => {
      const r = await asMember.get('/v1/accounts/:accountId/audit/webhooks', {
        params: { accountId: team.id },
      });
      r.status(403);
    });
    await ctx.step('MEMBER create webhook → 403', async () => {
      const r = await asMember.post(
        '/v1/accounts/:accountId/audit/webhooks',
        { name: 'x', url: 'https://example.com/x' },
        { params: { accountId: team.id } },
      );
      r.status(403);
    });

    // ── limit clamp semantics (never 400) ────────────────────────────────
    // limit=0 / negative → Math.max(raw,1) clamps to 1; non-numeric → default
    // 50; oversize → Math.min(_,MAX_LIMIT) clamps to 200. None of these 400.
    await ctx.step('limit=0 → clamps to 1 (200, ≤1 event)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '0' },
      });
      r.status(200).body().exists('$.events');
      const events = r.json<any>().events as unknown[];
      if (events.length > 1)
        throw new Error(`limit=0 should clamp to 1, got ${events.length} events`);
    });
    await ctx.step('limit=-5 → clamps to 1', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '-5' },
      });
      r.status(200);
      const events = r.json<any>().events as unknown[];
      if (events.length > 1)
        throw new Error(`limit=-5 should clamp to 1, got ${events.length} events`);
    });
    await ctx.step('limit=abc → default 50 (200, no 400)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: 'abc' },
      });
      r.status(200);
    });
    await ctx.step('limit=99999 → clamps to MAX_LIMIT=200 (no 400)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '99999' },
      });
      r.status(200);
      const events = r.json<any>().events as unknown[];
      if (events.length > 200)
        throw new Error(`limit=99999 should clamp to 200, got ${events.length} events`);
    });

    // ── cursor pagination round-trip (keyset integrity) ──────────────────
    // Fetch page 1 with limit=1, then page 2 with the returned cursor. The
    // two pages must not overlap (distinct event_ids). Skips gracefully when
    // there's no second page (account has 0–1 events).
    await ctx.step('cursor pagination → no overlap between pages', async () => {
      const p1 = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '1' },
      });
      p1.status(200);
      const p1body = p1.json<any>();
      const cursor = p1body.next_cursor;
      if (typeof cursor !== 'string') return; // no second page — nothing to overlap-check
      const p2 = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '1', cursor },
      });
      p2.status(200);
      const p2body = p2.json<any>();
      const p1ids = new Set((p1body.events as any[]).map((e) => e.event_id));
      const overlap = (p2body.events as any[]).some((e) => p1ids.has(e.event_id));
      if (overlap) throw new Error('cursor pagination: page 2 overlaps page 1');
    });

    // ── export headers + strict format schema ─────────────────────────────
    await ctx.step('export CSV → X-Audit-Row-Count + Content-Disposition headers', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/export', { params: { accountId: team.id } });
      r.status(200).headerExists('x-audit-row-count').headerExists('content-disposition');
    });
    await ctx.step(
      'export format=CSV (uppercase) → 400 (schema accepts lowercase csv|jsonl)',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit/export', {
          params: { accountId: team.id },
          query: { format: 'CSV' },
        });
        r.status(400);
      },
    );

    // ── webhook create input validation ──────────────────────────────────
    await ctx.step('create with missing name → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { url: 'https://example.com/x' },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step('create with oversize name (>128 chars) → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: 'x'.repeat(129), url: 'https://example.com/x' },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step('create with malformed url → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: 'bad', url: 'not-a-url' },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });
    await ctx.step('create with SSRF target (169.254.169.254 cloud metadata) → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: 'ssrf', url: 'https://169.254.169.254/latest/meta-data' },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    // ── webhook secret-once invariant ────────────────────────────────────
    // The plaintext signing secret is revealed EXACTLY ONCE on create; it
    // must never appear on subsequent reads (GET list, PATCH response). A
    // leak here would be a real security bug.
    let webhookId = '';
    await ctx.step('create reveals secret once → 201', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/audit/webhooks',
          { name: ctx.fixtures.name('hook'), url: 'https://example.com/ke2e-aud5' },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists('$.webhook_id').exists('$.secret');
      webhookId = r.json<any>().webhook_id;
    });
    await ctx.step('subsequent GET list does NOT reveal secret', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(200).body().exists('$.webhooks');
      const hooks = r.json<any>().webhooks as any[];
      const mine = hooks.find((h) => h.webhook_id === webhookId);
      if (!mine) throw new Error(`webhook ${webhookId} not in list`);
      if (mine.secret !== undefined)
        throw new Error(`secret leaked on GET list: ${String(mine.secret).slice(0, 8)}…`);
    });
    await ctx.step('PATCH response does NOT reveal secret', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/audit/webhooks/:webhookId',
          { enabled: false },
          { params: { accountId: team.id, webhookId } },
        );
      r.status(200);
      if (r.json<any>().secret !== undefined) throw new Error('secret leaked on PATCH response');
    });

    // ── cross-account isolation ──────────────────────────────────────────
    // The OWNER is admin of BOTH team (A) and teamB (the team() fixture uses
    // the global OWNER principal), so assertAuthorized(teamB, ACCOUNT_WRITE)
    // passes — but the WHERE clause filters by accountId=teamB AND
    // webhookId=<teamA's hook>, yielding no row → 404. This proves no
    // cross-account data leak via pathspoofed webhookId.
    const teamB = await ctx.fixtures.team({ enterprise: true });
    await ctx.step('cross-account PATCH (teamA hook via teamB path) → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/audit/webhooks/:webhookId',
          { enabled: true },
          { params: { accountId: teamB.id, webhookId } },
        );
      r.status(404);
    });
    await ctx.step('cross-account DELETE (teamA hook via teamB path) → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/:accountId/audit/webhooks/:webhookId', {
          params: { accountId: teamB.id, webhookId },
        });
      r.status(404);
    });

    // Sanity: the teamA webhook still exists after the cross-account no-ops.
    await ctx.step('teamA webhook still exists after cross-account no-ops', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(200);
      const hooks = r.json<any>().webhooks as any[];
      if (!hooks.some((h) => h.webhook_id === webhookId))
        throw new Error('teamA webhook missing after cross-account no-ops');
    });
  },
);

// AUD-FILTER — centralized reconstruction filters. UUID and enum filters reject
// invalid values. Dates, cursors, and limits retain their established lenient
// parsing and clamp behavior.
flow(
  'AUD-FILTER',
  {
    domain: 'audit',
    routes: ['GET /v1/accounts/:accountId/audit', 'GET /v1/projects/:projectId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();
    const base = { params: { accountId: team.id } };
    const correlationId = ctx.fixtures.name('audit-reconstruction');

    await ctx.step('an allowlisted client header attributes the SDK surface', async () => {
      const action = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId', {
          params: { projectId: project.id },
          headers: {
            'x-correlation-id': correlationId,
            'x-kortix-client': 'cli',
          },
        });
      action.status(200);

      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: {
          project_id: project.id,
          actor_type: 'human',
          source: 'cli',
          outcome: 'success',
          correlation_id: correlationId,
        },
      });
      r.status(200).body().exists('$.events');
      const events = r.json<{ events: Array<Record<string, unknown>> }>().events;
      if (events.length !== 1) {
        throw new Error(`expected one correlated event, got ${events.length}`);
      }
      const event = events[0];
      if (
        event.project_id !== project.id ||
        event.actor_type !== 'human' ||
        event.source !== 'cli' ||
        event.outcome !== 'success' ||
        event.correlation_id !== correlationId ||
        typeof event.request_id !== 'string' ||
        typeof event.trace_id !== 'string'
      ) {
        throw new Error(`centralized audit envelope mismatch: ${JSON.stringify(event)}`);
      }
    });

    await ctx.step('session filter accepts an exact session identifier', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { session_id: '00000000-0000-4000-a000-000000000000' },
      });
      r.status(200).body().exists('$.events');
    });

    await ctx.step('invalid structured filters → 400', async () => {
      const projectResponse = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit', {
          ...base,
          query: { project_id: 'not-a-uuid' },
        });
      projectResponse.status(400);

      const actorTypeResponse = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit', {
          ...base,
          query: { actor_type: 'robot' },
        });
      actorTypeResponse.status(400);
    });

    await ctx.step('actor filter (uuid) → 200 with events envelope', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { actor: '00000000-0000-4000-a000-000000000000' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('resource_type prefix filter → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { resource_type: 'project' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('since + until date-range window → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('q search substring → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { q: 'iam' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('cursor pagination param accepted → 200', async () => {
      // A well-formed cursor "<iso>|<uuid>" is accepted; a malformed one is
      // silently ignored (buildFilters only pushes the cursor condition when
      // the timestamp parses AND a lastId is present). Either way → 200.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { cursor: '2020-01-01T00:00:00Z|00000000-0000-4000-a000-000000000000' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('limit=0 is clamped to 1 (not 400)', async () => {
      // Math.max(limitRaw, 1) — a zero/negative limit can't 400; it's clamped up.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { limit: '0' },
      });
      r.status(200);
      const events = r.json<{ events: unknown[] }>().events;
      if (events.length > 1)
        throw new Error(`limit=0 should clamp to 1, got ${events.length} events`);
    });
    await ctx.step('limit=99999 is clamped to MAX_LIMIT (200), not 400', async () => {
      // Math.min(limitRaw, MAX_LIMIT=200) — an oversized limit is clamped down.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { limit: '99999' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('malformed since date is silently ignored → 200 (not 400)', async () => {
      // buildFilters guards Number.isNaN(since.getTime()) — a non-parseable
      // date adds no condition rather than 400ing. Pins the CURRENT contract;
      // a future fix that 400s here is a deliberate, visible delta.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { since: 'not-a-date' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('combined filters (actor + resource_type + q + window) → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: {
          actor: '00000000-0000-4000-a000-000000000000',
          resource_type: 'project',
          q: 'session',
          since: '2020-01-01T00:00:00Z',
          until: '2026-12-31T00:00:00Z',
          limit: '10',
        },
      });
      r.status(200).body().exists('$.events');
    });
  },
);
