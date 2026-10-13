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
  // OpenRouter-parity generation lookup and the no-op prewarm.
  ['GET', '/v1/generation'],
  ['POST', '/v1/prewarm'],
  // Suna → Kortix migration. Its only client was deleted on 2026-07-19.
  ['GET', '/v1/projects/suna-migration/eligibility'],
  ['GET', '/v1/projects/suna-migration/status'],
  ['POST', '/v1/projects/suna-migration/start'],
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
