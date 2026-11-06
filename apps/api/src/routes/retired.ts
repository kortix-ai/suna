import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

/**
 * The `code` a retired route answers with. The same value as the SDK's
 * `ENDPOINT_RETIRED_CODE`, so a client branches on one code whether the SDK
 * or the API reports the retirement.
 */
export const ENDPOINT_RETIRED_CODE = 'ENDPOINT_RETIRED';

/**
 * Routes the API removed (R6, 2026-10). Each one answers `410 Gone` with
 * `{ error, code: 'ENDPOINT_RETIRED' }` and runs no other code. Every row had
 * no in-repo caller and no first-party client call in prod in the 30 days
 * before it was retired. `ALL` matches every method.
 */
export const RETIRED_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  // Legacy router LLM + search. The LLM gateway (/v1/llm/*) and the
  // tavily/serper/firecrawl proxies replaced them.
  ['POST', '/v1/router/chat/completions'],
  ['GET', '/v1/router/models'],
  ['GET', '/v1/router/models/:model'],
  ['POST', '/v1/router/web-search'],
  ['POST', '/v1/router/image-search'],
  ...['openai', 'gemini', 'groq', 'xai', 'context7'].flatMap(
    (provider) =>
      [
        ['ALL', `/v1/router/${provider}`],
        ['ALL', `/v1/router/${provider}/*`],
      ] as const,
  ),
  // Duplicate mount of /v1/account/* (account deletion).
  ['GET', '/v1/billing/account/deletion-status'],
  ['POST', '/v1/billing/account/request-deletion'],
  ['POST', '/v1/billing/account/cancel-deletion'],
  ['DELETE', '/v1/billing/account/delete-immediately'],
  // Billing routes no client calls.
  ['POST', '/v1/billing/deduct'],
  ['POST', '/v1/billing/deduct-usage'],
  ['POST', '/v1/billing/sync-seat-quantity'],
  ['POST', '/v1/billing/create-checkout-session'],
  ['POST', '/v1/billing/confirm-checkout-session'],
  ['POST', '/v1/billing/schedule-downgrade'],
  // Credits-only billing (2026-10-14) replaced seats and the tier ladder with
  // POST /v1/billing/plan.
  ['POST', '/v1/billing/claim-per-seat'],
  ['POST', '/v1/billing/create-per-seat-checkout'],
  ['POST', '/v1/billing/create-inline-checkout'],
  ['POST', '/v1/billing/confirm-inline-checkout'],
  ['POST', '/v1/billing/cancel-scheduled-change'],
  ['GET', '/v1/billing/proration-preview'],
  // Enterprise is a feature layer (2026-10-15): a license contract
  // (POST /v1/admin/api/accounts/:id/enterprise-contract) or the account's own
  // demo toggle (PUT /v1/accounts/:accountId/iam/enterprise-demo). Trials are gone.
  ['POST', '/v1/admin/api/accounts/:id/enterprise-demo'],
  ['POST', '/v1/admin/api/accounts/:id/trial'],
  ['DELETE', '/v1/admin/api/accounts/:id/trial'],
  ['POST', '/v1/admin/api/accounts/:id/enterprise-entitlement'],
  ['POST', '/v1/admin/api/accounts/:id/managed-models'],
  // OpenRouter-parity generation lookup and the no-op prewarm.
  ['GET', '/v1/generation'],
  ['POST', '/v1/prewarm'],
  // Suna → Kortix migration. Its only client was deleted on 2026-07-19.
  ['GET', '/v1/projects/suna-migration/eligibility'],
  ['GET', '/v1/projects/suna-migration/status'],
  ['POST', '/v1/projects/suna-migration/start'],
  // Warm sessions (removed 2026-11-03). The flag was off for every project
  // but one internal project since 2026-10-21. Older web, SDK, CLI and mobile
  // builds call these only while `experimental.warm_sessions` reads true, and
  // the API now always sends false. A send then takes the ordinary create.
  ['POST', '/v1/projects/:workspaceId/sessions/warm'],
  ['POST', '/v1/projects/:workspaceId/sessions/warm/claim'],
  // Artifact comments, live presence, doc co-editing and the activity feed
  // (removed 2026-11-06). The `artifact_comments` flag was off for every
  // project but 5. Older web, SDK, TUI and mobile builds call these only
  // while `experimental.artifact_comments` reads true, and the API now
  // always sends false. A CLI in an older sandbox image still lists the
  // comment commands: they answer 410.
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
  ...['seed', 'updates', 'lease', 'flushed', 'reset'].map(
    (step) => ['POST', `/v1/projects/:workspaceId/artifacts/:artifactId/doc/${step}`] as const,
  ),
];

function gone(c: Context) {
  return c.json(
    { error: 'This endpoint was removed from the Kortix API.', code: ENDPOINT_RETIRED_CODE },
    410,
  );
}

/** Call before any other route mounts: call order is dispatch order. */
export function registerRetiredRoutes(app: OpenAPIHono): void {
  for (const [method, path] of RETIRED_ROUTES) app.on(method, path, gone);
}
