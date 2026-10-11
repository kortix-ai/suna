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
  ['GET', '/v1/generation'],
  ['POST', '/v1/prewarm'],
  ['GET', '/v1/projects/suna-migration/eligibility'],
  ['GET', '/v1/projects/suna-migration/status'],
  ['POST', '/v1/projects/suna-migration/start'],
];

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
          params: { model: 'any-model' },
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
