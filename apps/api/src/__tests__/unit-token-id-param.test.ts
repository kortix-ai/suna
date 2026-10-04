import { describe, expect, test, mock } from 'bun:test';
import { Hono } from 'hono';

// `DELETE /accounts/tokens/{tokenId}` handed the raw path param to the
// uuid-typed `account_tokens.token_id` query. A malformed id failed the
// Postgres cast (SQLSTATE 22P02) and surfaced as "HTTP 500: Internal server
// error" (KRTX-1330). The route must answer 400 naming the invalid id before
// the token query runs.

const ACCOUNT = crypto.randomUUID();
const ME = crypto.randomUUID();

/** The failure the Postgres `::uuid` cast raises for a malformed id. */
const UUID_CAST_ERROR = new Error('invalid input syntax for type uuid: "not-a-uuid"');

// Before the token query, the route runs exactly one other select: the
// `?account_id=` membership lookup. The fake answers that first select and
// throws the cast error on the second one, so the pre-fix route reaches the
// token query with the malformed id and dies the way prod did (500).
let selects = 0;
const chain: Record<string, unknown> = {
  from: () => chain,
  where: () => chain,
  orderBy: () => chain,
  limit: () => chain,
};
chain.then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
  Promise.resolve([{ accountId: ACCOUNT }]).then(res, rej);
mock.module('../lib/db', () => ({
  hasDatabase: true,
  db: {
    select: () => {
      selects += 1;
      if (selects > 1) throw UUID_CAST_ERROR;
      return chain;
    },
  },
}));

const { accountsRouter } = await import('../accounts/core/app');
const { registerTokenRoutes } = await import('../accounts/core/tokens');
registerTokenRoutes();

// The real server resolves the caller from the bearer token; the bare router
// has no auth middleware, so the test mounts one that stands in for it.
const app = new Hono<{ Variables: Record<string, unknown> }>();
app.use('*', async (c, next) => {
  c.set('userId', ME);
  c.set('authType', 'supabase');
  await next();
});
app.route('/', accountsRouter);

describe('tokens/:tokenId param validation', () => {
  test('DELETE with a non-UUID tokenId returns 400 naming the id', async () => {
    const res = await app.request(`/tokens/not-a-uuid?account_id=${ACCOUNT}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('not-a-uuid');
  });
});
