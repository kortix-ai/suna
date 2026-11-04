/**
 * SESS-62 — Session usage: what a session and every session it started cost, in USD.
 * Contract: tests/spec/end-to-end.md. Real-Postgres proofs of the rollup (order,
 * depth limit, cycles, deleted rows) live in
 * `apps/api/src/__tests__/integration-session-usage.test.ts`.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { withDb } from '../fixtures/chat';

type Usage = {
  currency: string;
  total: { cost: number; kortix_cost: number; provider_cost: number; request_count: number };
  sessions: Array<{ session_id: string; parent_session_id: string | null; depth: number; cost: number }>;
  hidden_sessions: number;
  truncated: boolean;
};

flow(
  'SESS-62',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/usage'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const seed = async (visibility: 'project' | 'private', parentSessionId?: string) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility,
        parentSessionId,
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const root = await seed('project');
    const child = await seed('project', root);
    const grandchild = await seed('project', child);
    const privateChild = await seed('private', root);
    // Wallet spend on three sessions, own-key spend on one.
    await withDb(ctx, (db) =>
      db.query(
        `INSERT INTO kortix.gateway_request_logs
           (request_id, account_id, project_id, session_id, requested_model, resolved_model, provider, status, ok,
            final_cost_precise, upstream_cost_precise, billing_mode)
         SELECT 'sess62-' || s || '-' || gen_random_uuid(), $1::uuid, $2::uuid, s, 'ke2e', 'ke2e', 'ke2e', 200, true,
                k, u, m
           FROM unnest($3::text[], $4::numeric[], $5::numeric[], $6::text[]) AS t(s, k, u, m)`,
        [
          team.id,
          project.id,
          [root, child, grandchild, privateChild],
          [0.1, 0.2, 0, 1],
          [0.05, 0.1, 0.3, 0.5],
          ['credits', 'credits', 'none', 'credits'],
        ],
      ),
    );
    const route = '/v1/projects/:projectId/sessions/:sessionId/usage';
    const read = async (as: ReturnType<typeof ctx.client.as>, sessionId: string) =>
      (await as.get(route, { params: { projectId: project.id, sessionId } })).status(200).json<Usage>();
    const expect = (what: string, actual: unknown, wanted: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
      }
    };

    await ctx.step('the owner reads the whole tree: every session, wallet plus own-key spend, in USD → 200', async () => {
      const usage = await read(owner, root);
      expect('currency', usage.currency, 'USD');
      expect('order', usage.sessions.map((s) => [s.session_id, s.depth]).filter(([id]) => id !== privateChild), [
        [root, 0],
        [child, 1],
        [grandchild, 2],
      ]);
      expect('session count', usage.sessions.length, 4);
      // A managed request's upstream cost is Kortix's, not the customer's: only final cost counts.
      expect('total', usage.total, { ...usage.total, cost: 1.6, kortix_cost: 1.3, provider_cost: 0.3, request_count: 4 });
      expect('hidden', usage.hidden_sessions, 0);
    });

    await ctx.step('a member sees only the sessions they may open; a private child is counted, not shown → 200', async () => {
      const usage = await read(ctx.client.as(member), root);
      expect('sessions', usage.sessions.map((s) => s.session_id), [root, child, grandchild]);
      expect('total cost', usage.total.cost, 0.6);
      expect('hidden', usage.hidden_sessions, 1);
    });

    await ctx.step('a child read starts at the child: its own subtree, no parent → 200', async () => {
      const usage = await read(owner, child);
      expect('sessions', usage.sessions.map((s) => [s.session_id, s.parent_session_id]), [
        [child, null],
        [grandchild, child],
      ]);
      expect('total cost', usage.total.cost, 0.5);
    });

    await ctx.step('a session the viewer cannot see → 404; a non-UUID id → 400; anonymous → 401', async () => {
      const as = ctx.client.as(member);
      (await as.get(route, { params: { projectId: project.id, sessionId: privateChild } })).status(404);
      (await as.get(route, { params: { projectId: project.id, sessionId: 'nope' } })).status(400);
      (await ctx.client.as(ctx.P.ANON).get(route, { params: { projectId: project.id, sessionId: root } })).status(401);
    });
  },
);
