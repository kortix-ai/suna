/**
 * Account-scoped audit surface (apps/api/src/accounts/audit.ts, mounted under
 * /v1/accounts). Reads gated on audit.read; webhook CRUD gated on account.write.
 * Uses ctx.fixtures.team() — OWNER is authorized, NONMEMBER → 403. Maps to AUD-*.
 */
import { flow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import { serveFixtureRepoLocally } from '../fixtures/local-git';

interface AuditPageBody {
  events: Array<{ event_id: string }>;
  next_cursor: string | null;
}

interface AuditWebhookBody {
  webhook_id: string;
  secret?: string;
}

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
      webhookId = r.json<AuditWebhookBody>().webhook_id;
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
//   - strict limit validation: zero, negative, non-numeric, and values above
//     MAX_LIMIT are rejected with 400
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

    // ── strict limit validation ──────────────────────────────────────────
    await ctx.step('limit=0 → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '0' },
      });
      r.status(400);
    });
    await ctx.step('limit=-5 → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '-5' },
      });
      r.status(400);
    });
    await ctx.step('limit=abc → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: 'abc' },
      });
      r.status(400);
    });
    await ctx.step('limit=99999 → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '99999' },
      });
      r.status(400);
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
      const p1body = p1.json<AuditPageBody>();
      const cursor = p1body.next_cursor;
      if (typeof cursor !== 'string') return; // no second page — nothing to overlap-check
      const p2 = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { limit: '1', cursor },
      });
      p2.status(200);
      const p2body = p2.json<AuditPageBody>();
      const p1ids = new Set(p1body.events.map((event) => event.event_id));
      const overlap = p2body.events.some((event) => p1ids.has(event.event_id));
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
      webhookId = r.json<AuditWebhookBody>().webhook_id;
    });
    await ctx.step('subsequent GET list does NOT reveal secret', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/audit/webhooks', { params: { accountId: team.id } });
      r.status(200).body().exists('$.webhooks');
      const hooks = r.json<{ webhooks: AuditWebhookBody[] }>().webhooks;
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
      if (r.json<AuditWebhookBody>().secret !== undefined)
        throw new Error('secret leaked on PATCH response');
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
      const hooks = r.json<{ webhooks: AuditWebhookBody[] }>().webhooks;
      if (!hooks.some((h) => h.webhook_id === webhookId))
        throw new Error('teamA webhook missing after cross-account no-ops');
    });
  },
);

// AUD-FILTER — centralized reconstruction filters fail closed. Malformed UUIDs,
// enums, timestamps, cursors, and limits return 400 instead of silently
// widening the query.
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
      const action = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId', {
        params: { projectId: project.id },
        headers: {
          'x-correlation-id': correlationId,
          'x-kortix-client': 'cli',
        },
      });
      action.status(200);

      // Audit writes are an in-process async queue since #6618
      // (apps/api/src/shared/audit-queue.ts, 250 ms batch timer). The list
      // route flushes — but flushes ITS OWN process's queue, and deployed
      // staging runs 3 API tasks, so the read usually lands on a task that did
      // not emit the event. Run 32306385663 read 0 events for that reason. Poll
      // until the emitter's own timer has flushed; the strict envelope
      // assertions below are unchanged. Never make audit writes synchronous.
      const r = await waitFor(
        async () =>
          ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
            ...base,
            query: {
              project_id: project.id,
              actor_type: 'human',
              source: 'cli',
              outcome: 'success',
              correlation_id: correlationId,
            },
          }),
        {
          until: (res) =>
            res.statusCode === 200 &&
            (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 15_000,
          intervalMs: 500,
          description: `the correlated audit event for ${correlationId} to be flushed`,
          retryOnError: isKe2eRetryableError,
        },
      );
      r.status(200).body().exists('$.events');
      const events = r.json<{ events: Array<Record<string, unknown>> }>().events;
      if (events.length !== 1) {
        throw new Error(`expected one correlated event, got ${events.length}`);
      }
      const event = events[0];
      if (
        event.project_id !== project.id ||
        event.actor_type !== 'human' ||
        event.authoritative_source !== 'human' ||
        event.client_reported_source !== 'cli' ||
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
      // A well-formed cursor "<iso>|<uuid>" is accepted.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { cursor: '2020-01-01T00:00:00Z|00000000-0000-4000-a000-000000000000' },
      });
      r.status(200).body().exists('$.events');
    });
    await ctx.step('limit=0 is rejected → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { limit: '0' },
      });
      r.status(400);
    });
    await ctx.step('limit=99999 is rejected → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { limit: '99999' },
      });
      r.status(400);
    });
    await ctx.step('malformed since date is rejected → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        ...base,
        query: { since: 'not-a-date' },
      });
      r.status(400);
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

// AUD-6 — centralized v2 project, reconciliation, delivery-ledger, replay, and
// sandbox-ingestion security contracts.
flow(
  'AUD-6',
  {
    domain: 'audit',
    routes: [
      'GET /v1/projects/:projectId/audit',
      'POST /v1/accounts/:accountId/audit/reconcile',
      'GET /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries',
      'POST /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries/:deliveryId/replay',
      'POST /v1/projects/:projectId/sessions/:sessionId/audit/events',
      'POST /v1/accounts/:accountId/audit/webhooks',
      'DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    let webhookId = '';
    let deliveryId = '';

    await ctx.step('project-scoped canonical audit page → 200', async () => {
      const r = await owner.get('/v1/projects/:projectId/audit', {
        params: { projectId: project.id },
        query: { limit: '10' },
      });
      r.status(200).body().exists('$.events').has('$.next_cursor', null);
    });

    await ctx.step('create a webhook scoped to reconciliation events', async () => {
      const r = await owner.post(
        '/v1/accounts/:accountId/audit/webhooks',
        {
          name: ctx.fixtures.name('audit-v2'),
          url: 'https://example.com/ke2e-audit-v2',
          action_prefix: 'iam.audit.reconcile',
        },
        { params: { accountId: team.id } },
      );
      r.status(201).body().exists('$.webhook_id');
      webhookId = r.json<{ webhook_id: string }>().webhook_id;
    });

    await ctx.step('bounded reconciliation → 200 idempotent result', async () => {
      const r = await owner.post('/v1/accounts/:accountId/audit/reconcile', undefined, {
        params: { accountId: team.id },
        query: { limit: '100' },
      });
      r.status(200).body().exists('$.inserted').exists('$.complete').exists('$.by_source');
    });

    await ctx.step('delivery ledger contains the reconciliation event', async () => {
      const r = await owner.get('/v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries', {
        params: { accountId: team.id, webhookId },
      });
      r.status(200).body().exists('$.deliveries');
      const deliveries = r.json<{ deliveries: Array<{ delivery_id: string }> }>().deliveries;
      if (deliveries.length === 0) throw new Error('expected a durable audit webhook delivery');
      const delivery = deliveries[0];
      if (!delivery) throw new Error('expected a durable audit webhook delivery');
      deliveryId = delivery.delivery_id;
    });

    await ctx.step('manual delivery replay returns replayed=true', async () => {
      const r = await owner.post(
        '/v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries/:deliveryId/replay',
        undefined,
        { params: { accountId: team.id, webhookId, deliveryId } },
      );
      r.status(200).body().has('$.replayed', true);
    });

    await ctx.step('human auth cannot ingest sandbox OpenCode events → 403', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/audit/events',
        { events: [] },
        {
          params: {
            projectId: project.id,
            sessionId: '00000000-0000-4000-a000-000000000001',
          },
        },
      );
      r.status(403);
    });

    await ctx.step('delete the test webhook', async () => {
      const r = await owner.del('/v1/accounts/:accountId/audit/webhooks/:webhookId', {
        params: { accountId: team.id, webhookId },
      });
      r.status(200).body().has('$.deleted', true);
    });
  },
);

// ── AUD-7: every inbound request is audited, whoever it names ────────────────
// The Git proxy authenticates its own credential, so the old request audit
// never saw a caller there and wrote no row for a clone or a push. The audit
// boundary now writes one row per inbound request; the proxy binds the caller
// it proved and names the transfer. A request nobody identified is written as
// `anonymous` instead of skipped.
interface AuditRow {
  event_id: string;
  account_id: string | null;
  project_id: string | null;
  actor_user_id: string | null;
  actor_type: string | null;
  authoritative_source: string | null;
  outcome: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  http_status: number | null;
  correlation_id: string | null;
  metadata: {
    http?: string;
    auth?: { kind?: string; token_id?: string };
    refs?: Array<{ ref: string; old_sha: string; new_sha: string; kind: string }>;
  };
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`AUD-7 needs ${label}`);
  return value;
}

flow(
  'AUD-7',
  {
    domain: 'audit',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/git/:project/info/refs',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
      'GET /v1/projects/:projectId',
      'GET /v1/accounts/:accountId/audit',
    ],
  },
  async (ctx) => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { Client: PgClient } = await import('pg');
    const exec = promisify(execFile);
    const team = await ctx.fixtures.team({ enterprise: true });
    const outsider = await team.addMember('member');
    const projectMember = await team.addMember('member');
    const project = await team.project({ managedGit: true });
    const outsiderId = required(outsider.userId, 'the account member\u2019s user id');
    const projectMemberId = required(projectMember.userId, 'the project member\u2019s user id');
    await team.grantProjectRole(project.id, projectMemberId, 'member');
    const ownerId = required(ctx.P.OWNER.userId, 'the owner\u2019s user id');
    const databaseUrl = required(ctx.env.databaseUrl, 'a database URL');
    const db = new PgClient({ connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
    await db.connect();
    const root = await mkdtemp(join(tmpdir(), 'ke2e-audit-git-'));
    const branch = `refs/heads/${ctx.fixtures.name('aud7').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const tokenIds: string[] = [];
    let localGitServer: import('node:http').Server | null = null;
    let branchPushed = false;
    let ownerSecret: string | null = null;
    const remoteUrl = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;

    const personalToken = async (identity: typeof ctx.P.OWNER, label: string) => {
      const created = await ctx.client.as(identity).post('/v1/accounts/tokens', {
        name: `AUD-7 ${label}`, account_id: team.id,
      });
      created.status(201);
      const body = created.json<{ token_id: string; secret_key: string }>();
      tokenIds.push(body.token_id);
      return body;
    };
    const git = async (secret: string, args: string[], expected: 'ok' | 'rejected') => {
      let code = 0;
      let output = '';
      try {
        const result = await exec('git', args, { cwd: root, timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` } });
        output = result.stdout + result.stderr;
      } catch (error) {
        const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        code = typeof failed.code === 'number' ? failed.code : -1;
        output = String(failed.stdout ?? '') + String(failed.stderr ?? '');
      }
      if ((expected === 'ok') !== (code === 0)) {
        throw new Error(`git ${args[0]}: expected ${expected}, got exit ${code}: ${output.replaceAll(secret, '[redacted]')}`);
      }
      return output;
    };
    // Audit writes are an asynchronous queue, and a deployed target runs
    // several API tasks; poll the account log until the row is there.
    const auditRows = (query: Record<string, string>, description: string, send?: () => Promise<unknown>) =>
      waitFor(
        async () => {
          if (send) await send();
          return ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
            params: { accountId: team.id },
            query: { project_id: project.id, limit: '50', ...query },
          });
        },
        {
          until: (res) => res.statusCode === 200 && (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 20_000,
          intervalMs: 500,
          description,
          retryOnError: isKe2eRetryableError,
        },
      ).then((res) => {
        res.status(200);
        return res.json<{ events: AuditRow[] }>().events;
      });
    const expectRow = (row: AuditRow | undefined, expected: Partial<AuditRow>, label: string): AuditRow => {
      if (!row) throw new Error(`${label}: no row`);
      for (const [key, value] of Object.entries(expected)) {
        if (row[key as keyof AuditRow] !== value) {
          throw new Error(`${label}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(row)}`);
        }
      }
      return row;
    };

    try {
      localGitServer = await serveFixtureRepoLocally(ctx, db, project.id, 'AUD-7');
      const remote = remoteUrl;
      const owner = await personalToken(ctx.P.OWNER, 'owner');
      ownerSecret = owner.secret_key;
      const outsiderToken = await personalToken(outsider, 'account member');
      const memberToken = await personalToken(projectMember, 'project member');

      await ctx.step('the owner clones through the Git proxy; a git.clone row names the owner and the token', async () => {
        await git(owner.secret_key, ['clone', remote, '.'], 'ok');
        const rows = await auditRows({ action: 'git.clone', actor: ownerId }, 'the owner’s git.clone row');
        const row = expectRow(rows[0], {
          account_id: team.id,
          project_id: project.id,
          actor_user_id: ownerId,
          actor_type: 'human',
          authoritative_source: 'api_key',
          outcome: 'success',
          action: 'git.clone',
          resource_type: 'git_repository',
          resource_id: project.id,
          http_status: 200,
        }, 'git.clone');
        if (row.metadata.auth?.kind !== 'git' || row.metadata.auth?.token_id !== owner.token_id) {
          throw new Error(`git.clone must name the token, never its secret: ${JSON.stringify(row.metadata)}`);
        }
        if (!/git-upload-pack$/.test(String(row.metadata.http))) {
          throw new Error(`git.clone must keep its HTTP identity: ${JSON.stringify(row.metadata)}`);
        }
        if (JSON.stringify(row).includes(owner.secret_key)) throw new Error('the row contains the token secret');
      });

      await ctx.step('the owner pushes a new branch; a git.push row records the ref it created', async () => {
        await writeFile(join(root, 'aud7.txt'), 'audited push\n');
        await git(owner.secret_key, ['add', 'aud7.txt'], 'ok');
        await git(owner.secret_key, ['-c', 'user.name=KE2E', '-c', 'user.email=ke2e@kortix.ai', 'commit', '-m', 'AUD-7 probe'], 'ok');
        const head = (await git(owner.secret_key, ['rev-parse', 'HEAD'], 'ok')).trim();
        await git(owner.secret_key, ['push', remote, `HEAD:${branch}`], 'ok');
        branchPushed = true;
        const rows = await auditRows(
          { action: 'git.push', actor: ownerId, outcome: 'success' },
          'the owner’s git.push row',
        );
        const row = expectRow(rows[0], { actor_type: 'human', resource_id: project.id, http_status: 200 }, 'git.push');
        const refs = row.metadata.refs;
        const created = refs?.find((entry) => entry.ref === branch);
        if (!created || created.kind !== 'create' || created.new_sha !== head || !/^0{40}$/.test(created.old_sha ?? '')) {
          throw new Error(`git.push must record ${branch} created at ${head}: ${JSON.stringify(refs)}`);
        }
      });

      await ctx.step('the owner deletes the branch; its git.push row records the delete', async () => {
        await git(owner.secret_key, ['push', remote, `:${branch}`], 'ok');
        branchPushed = false;
        const rows = await waitFor(
          () => auditRows({ action: 'git.push', actor: ownerId, outcome: 'success' }, 'the owner’s git.push rows'),
          {
            until: (events) => events.some((row) => (row.metadata.refs ?? []).some((entry) => entry.ref === branch && entry.kind === 'delete')),
            timeoutMs: 20_000,
            intervalMs: 500,
            description: `the delete of ${branch} in the audit log`,
            retryOnError: isKe2eRetryableError,
          },
        );
        if (rows.length < 2) throw new Error(`expected a create and a delete row, got ${rows.length}`);
      });

      await ctx.step('an account member with no project role is refused, and the refusal names them', async () => {
        const read = await git(outsiderToken.secret_key, ['ls-remote', remote], 'rejected');
        if (!/403|not authorized/i.test(read)) throw new Error(`expected a 403 refusal, got: ${read}`);
        const rows = await auditRows(
          { actor: outsiderId, outcome: 'denied' },
          'the account member’s denied git row',
        );
        const row = expectRow(rows[0], {
          account_id: team.id,
          actor_type: 'human',
          authoritative_source: 'api_key',
          http_status: 403,
          action: 'git.ref.list',
        }, 'account member refusal');
        if (row.metadata.http !== 'GET /v1/git/:project/info/refs') {
          throw new Error(`the refusal keeps its HTTP identity: ${JSON.stringify(row.metadata)}`);
        }
        if (row.metadata.auth?.token_id !== outsiderToken.token_id) {
          throw new Error(`the refusal must name the refused token: ${JSON.stringify(row.metadata)}`);
        }
      });

      await ctx.step('a project member without gitops.push is refused a push, and the refusal names them', async () => {
        await git(memberToken.secret_key, ['push', remote, 'HEAD:refs/heads/main'], 'rejected');
        const rows = await auditRows(
          { actor: projectMemberId, outcome: 'denied' },
          'the project member’s denied push row',
        );
        expectRow(rows[0], { actor_type: 'human', http_status: 403, action: 'git.ref.list' }, 'project member refusal');
      });

      await ctx.step('an unauthenticated request to the project is an anonymous row in the owner’s log', async () => {
        const correlationId = ctx.fixtures.name('aud7-anonymous');
        // The anonymous budget may drop one probe under load; each poll sends
        // another, so the step waits for a written one rather than a lucky one.
        const rows = await auditRows(
          { actor_type: 'anonymous', correlation_id: correlationId },
          'the anonymous probe row',
          () => ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId', {
            params: { projectId: project.id },
            headers: { 'x-correlation-id': correlationId },
          }),
        );
        for (const row of rows) {
          expectRow(row, {
            account_id: team.id,
            project_id: project.id,
            actor_user_id: null,
            actor_type: 'anonymous',
            authoritative_source: 'anonymous',
            outcome: 'denied',
            http_status: 401,
            resource_type: 'project',
            resource_id: project.id,
          }, 'anonymous probe');
          // The auth middleware refuses before the handler runs, and the row
          // still names the endpoint the request asked for: its label, and
          // its template in `metadata.http`. Never the raw path.
          if (row.action !== 'project.read' || row.metadata.http !== 'GET /v1/projects/:projectId') {
            throw new Error(`anonymous probe: expected project.read, got ${JSON.stringify(row)}`);
          }
        }
      });

      await ctx.step('the actor_type filter still refuses an unknown type → 400', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
          params: { accountId: team.id },
          query: { actor_type: 'robot' },
        });
        r.status(400);
      });
    } finally {
      // A failed step can leave the probe branch on the project repository.
      if (branchPushed && ownerSecret) {
        await git(ownerSecret, ['push', remoteUrl, `:${branch}`], 'ok').catch(() => {});
      }
      for (const tokenId of tokenIds) {
        await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]);
      }
      const server = localGitServer;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// ── AUD-8: a request row is named by its route's audit label ────────────────
// Every route has one label in `@kortix/shared/audit-labels`: a
// `domain.resource.verb` action that filters by prefix, and a title the web
// and the CLI show. The row keeps the route template in `metadata.http`. A
// handler that records its own event for the request makes that event the
// request's only row. A request no endpoint matched is `api.route.unmatched`.
flow(
  'AUD-8',
  {
    domain: 'audit',
    routes: [
      'GET /v1/projects/:projectId',
      'POST /v1/accounts/:accountId/iam/groups',
      'DELETE /v1/accounts/:accountId/iam/groups/:groupId',
      'GET /v1/accounts/:accountId/audit',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    let groupId: string | null = null;
    const auditRows = (query: Record<string, string>, description: string) =>
      waitFor(
        () => owner.get('/v1/accounts/:accountId/audit', { params, query: { limit: '50', ...query } }),
        {
          until: (res) => res.statusCode === 200 && (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 20_000,
          intervalMs: 500,
          description,
          retryOnError: isKe2eRetryableError,
        },
      ).then((res) => {
        res.status(200);
        return res.json<{ events: AuditRow[] }>().events;
      });

    try {
      await ctx.step('the owner reads the project; its row is `project.read`, with the route in metadata.http', async () => {
        const read = await owner.get('/v1/projects/:projectId', { params: { projectId: project.id } });
        read.status(200);
        const requestId = required(read.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the project read row');
        const row = rows[0];
        if (!row || row.action !== 'project.read' || row.metadata.http !== 'GET /v1/projects/:projectId') {
          throw new Error(`expected project.read with its HTTP identity, got ${JSON.stringify(rows)}`);
        }
        if (JSON.stringify(row.metadata).includes(project.id)) {
          throw new Error(`metadata must carry the template, not the path: ${JSON.stringify(row.metadata)}`);
        }
      });

      await ctx.step('the `project.` action prefix selects the labelled row', async () => {
        const rows = await auditRows({ action: 'project.', project_id: project.id }, 'project.* rows');
        const off = rows.filter((row) => !row.action.startsWith('project.'));
        if (off.length > 0) throw new Error(`the prefix filter returned ${JSON.stringify(off.map((row) => row.action))}`);
      });

      await ctx.step("creating a group writes one row: the handler's own `iam.group.create` event", async () => {
        const created = await owner.post(
          '/v1/accounts/:accountId/iam/groups',
          { name: ctx.fixtures.name('aud8-group') },
          { params },
        );
        created.status(201);
        groupId = created.json<{ group_id: string }>().group_id;
        const requestId = required(created.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the group create row');
        if (rows.length !== 1 || rows[0]?.action !== 'iam.group.create') {
          throw new Error(`expected exactly one iam.group.create row, got ${JSON.stringify(rows.map((row) => row.action))}`);
        }
      });

      await ctx.step('a request no endpoint matched is `api.route.unmatched`, never its raw path', async () => {
        const missing = await owner.get('/v1/projects/:projectId/aud8-no-such-route', {
          params: { projectId: project.id },
        });
        missing.status(404);
        const requestId = required(missing.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the unmatched request row');
        const row = rows[0];
        if (!row || row.action !== 'api.route.unmatched' || row.http_status !== 404) {
          throw new Error(`expected api.route.unmatched 404, got ${JSON.stringify(rows)}`);
        }
        if (JSON.stringify(row).includes('aud8-no-such-route')) {
          throw new Error(`the unmatched row must not carry the raw path: ${JSON.stringify(row)}`);
        }
      });
    } finally {
      if (groupId) {
        await owner.del('/v1/accounts/:accountId/iam/groups/:groupId', {
          params: { ...params, groupId },
        });
      }
    }
  },
);
