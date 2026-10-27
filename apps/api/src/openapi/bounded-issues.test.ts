/**
 * A validation failure answers a bounded body (KRTX-3419).
 *
 * Zod reports one issue per failing array element. Before the cap, 500,000
 * invalid elements in a 1.5 MB request answered 68 MB.
 */
import { describe, expect, test } from 'bun:test';
import { createRoute, z } from '@hono/zod-openapi';
import { RESPONSE_ISSUE_LIMIT, boundedIssues, makeOpenApiApp } from './index';

function appWithBody(schema: z.ZodTypeAny) {
  const app = makeOpenApiApp();
  app.openapi(
    createRoute({
      method: 'post',
      path: '/items',
      request: { body: { content: { 'application/json': { schema } } } },
      responses: { 200: { description: 'OK' } },
    }),
    (c) => c.json({ ok: true }),
  );
  return app;
}

const post = (schema: z.ZodTypeAny, body: unknown) =>
  appWithBody(schema).request('/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('validation issues in a response', () => {
  test('5,000 invalid array elements answer the first 20 issues and the total', async () => {
    const res = await post(z.object({ patterns: z.array(z.string()) }), { patterns: Array(5000).fill(1) });
    const text = await res.text();
    const body = JSON.parse(text);

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: true, message: 'Validation failed', status: 400, issue_count: 5000 });
    expect(body.issues).toHaveLength(RESPONSE_ISSUE_LIMIT);
    expect(body.issues[0].path).toEqual(['patterns', 0]);
    expect(text.length).toBeLessThan(10_000);
  });

  test('a union over an array branch nests each element error in ONE issue; the body stays small', async () => {
    // Zod puts a failing branch's whole issue list in `unionErrors` of one
    // invalid_union issue, so a count cap alone kept every element error.
    const Event = z.object({ name: z.string() });
    const res = await post(Event.or(z.object({ events: z.array(Event) })), { events: Array(5000).fill({}) });
    const text = await res.text();
    const body = JSON.parse(text);

    expect(res.status).toBe(400);
    expect(body.issue_count).toBe(1);
    expect(body.issues[0].code).toBe('invalid_union');
    expect(body.issues[0].unionErrors).toBeUndefined();
    expect(body.issues[0].union_errors[1].issue_count).toBe(5000);
    expect(text.length).toBeLessThan(20_000);
  });

  test('a short list stays whole, with its count', () => {
    expect(boundedIssues(['a', 'b'])).toEqual({ issues: ['a', 'b'], issue_count: 2 });
    expect(boundedIssues(undefined)).toEqual({ issues: [], issue_count: 0 });
  });
});
