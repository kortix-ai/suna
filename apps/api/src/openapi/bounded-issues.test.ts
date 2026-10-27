/**
 * A validation failure answers a bounded body (KRTX-3419).
 *
 * Zod reports one issue per failing array element. Before the cap, 500,000
 * invalid elements in a 1.5 MB request answered 68 MB.
 */
import { describe, expect, test } from 'bun:test';
import { createRoute, z } from '@hono/zod-openapi';
import { RESPONSE_ISSUE_LIMIT, boundedIssues, makeOpenApiApp } from './index';

function appWithArrayBody() {
  const app = makeOpenApiApp();
  app.openapi(
    createRoute({
      method: 'post',
      path: '/items',
      request: { body: { content: { 'application/json': { schema: z.object({ patterns: z.array(z.string()) }) } } } },
      responses: { 200: { description: 'OK' } },
    }),
    (c) => c.json({ ok: true }),
  );
  return app;
}

describe('validation issues in a response', () => {
  test('5,000 invalid array elements answer the first 20 issues and the total', async () => {
    const res = await appWithArrayBody().request('/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patterns: Array(5000).fill(1) }),
    });
    const text = await res.text();
    const body = JSON.parse(text);

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: true, message: 'Validation failed', status: 400, issue_count: 5000 });
    expect(body.issues).toHaveLength(RESPONSE_ISSUE_LIMIT);
    expect(body.issues[0].path).toEqual(['patterns', 0]);
    expect(text.length).toBeLessThan(10_000);
  });

  test('a short list stays whole, with its count', () => {
    expect(boundedIssues(['a', 'b'])).toEqual({ issues: ['a', 'b'], issue_count: 2 });
    expect(boundedIssues(undefined)).toEqual({ issues: [], issue_count: 0 });
  });
});
