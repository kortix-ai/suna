/**
 * RET-1 — retired routes. The API keeps each removed route as a stub that
 * answers `410 { error, code: "ENDPOINT_RETIRED" }` and runs no handler
 * (apps/api/src/routes/retired.ts). The `ALL /v1/router/<provider>[/*]` stubs
 * cannot be declared here (no flow declares method ALL); one concrete call to
 * them still proves the stub answers.
 */
import { flow } from '../core/flow';

const RETIRED: Array<[method: string, template: string]> = [
  ['POST', '/v1/router/chat/completions'],
  ['GET', '/v1/router/models'],
  ['GET', '/v1/router/models/:model'],
  ['POST', '/v1/router/web-search'],
  ['POST', '/v1/router/image-search'],
  ['GET', '/v1/billing/account/deletion-status'],
  ['POST', '/v1/billing/account/request-deletion'],
  ['POST', '/v1/billing/account/cancel-deletion'],
  ['DELETE', '/v1/billing/account/delete-immediately'],
  ['POST', '/v1/billing/deduct'],
  ['POST', '/v1/billing/deduct-usage'],
  ['POST', '/v1/billing/sync-seat-quantity'],
  ['POST', '/v1/billing/create-checkout-session'],
  ['POST', '/v1/billing/confirm-checkout-session'],
  ['POST', '/v1/billing/schedule-downgrade'],
  ['POST', '/v1/billing/claim-per-seat'],
  ['POST', '/v1/billing/create-per-seat-checkout'],
  ['POST', '/v1/billing/create-inline-checkout'],
  ['POST', '/v1/billing/confirm-inline-checkout'],
  ['POST', '/v1/billing/cancel-scheduled-change'],
  ['GET', '/v1/billing/proration-preview'],
  ['GET', '/v1/generation'],
  ['POST', '/v1/prewarm'],
  ['GET', '/v1/projects/suna-migration/eligibility'],
  ['GET', '/v1/projects/suna-migration/status'],
  ['POST', '/v1/projects/suna-migration/start'],
  // One plan system (2026-10-15): the Enterprise preview became a dated trial,
  // and Enterprise is set by a contract.
  ['POST', '/v1/admin/api/accounts/:id/enterprise-demo'],
  ['POST', '/v1/admin/api/accounts/:id/trial'],
  ['DELETE', '/v1/admin/api/accounts/:id/trial'],
  ['POST', '/v1/admin/api/accounts/:id/enterprise-entitlement'],
  ['POST', '/v1/admin/api/accounts/:id/managed-models'],
  // Artifact comments, live presence, doc co-editing and the activity feed
  // (removed 2026-11-06, #11963).
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/comments'],
  ['POST', '/v1/projects/:workspaceId/artifacts/:artifactId/comments'],
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/context'],
  ['POST', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/send'],
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/:commentId/screenshot'],
  ['POST', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/:threadId/replies'],
  ['PATCH', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/:threadId'],
  ['PATCH', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/:threadId/:commentId'],
  ['DELETE', '/v1/projects/:workspaceId/artifacts/:artifactId/comments/:threadId/:commentId'],
  ['GET', '/v1/projects/:workspaceId/artifact-comment-threads/:threadId'],
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/activity'],
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/live'],
  ['POST', '/v1/projects/:workspaceId/artifacts/:artifactId/live/ticket'],
  ['POST', '/v1/projects/:workspaceId/artifacts/:artifactId/live/agent'],
  ['GET', '/v1/projects/:workspaceId/artifacts/:artifactId/doc'],
  ...(['seed', 'updates', 'lease', 'flushed', 'reset'] as const).map(
    (step): [string, string] => ['POST', `/v1/projects/:workspaceId/artifacts/:artifactId/doc/${step}`],
  ),
];

const ANY_UUID = '00000000-0000-4000-a000-000000000000';

flow(
  'RET-1',
  {
    domain: 'system',
    routes: RETIRED.map(([method, template]) => `${method} ${template}`),
  },
  async (ctx) => {
    await ctx.step('every retired route answers ANON with 410 ENDPOINT_RETIRED', async () => {
      for (const [method, template] of RETIRED) {
        const r = await ctx.client.as(ctx.P.ANON).request(method, template, {
          params: { model: 'any-model', accountId: ANY_UUID, id: ANY_UUID, workspaceId: ANY_UUID, artifactId: ANY_UUID, commentId: ANY_UUID, threadId: ANY_UUID },
          body: method === 'GET' || method === 'DELETE' ? undefined : {},
        });
        r.status(410).body().has('$.code', 'ENDPOINT_RETIRED');
      }
    });
    await ctx.step('a signed-in OWNER gets the same 410: no handler runs', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/deduct-usage', { amount: 1 });
      r.status(410).body().has('$.code', 'ENDPOINT_RETIRED');
    });
    await ctx.step('a retired provider passthrough answers 410', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/router/openai/chat/completions', {});
      r.status(410).body().has('$.code', 'ENDPOINT_RETIRED');
    });
    await ctx.step('the surviving /v1/account mount still serves deletion status', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/account/deletion-status');
      r.status(200).body().exists('$.has_pending_deletion');
    });
  },
);
