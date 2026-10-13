/**
 * Integration test (real DB, real route): a memoized 304 keeps the account
 * attribution the computed path performs.
 *
 * The dashboard polls with a browser JWT, and the JWT principal never binds
 * the account on the context — `loadProjectForUser` does, mid-route, on the
 * computed path. The poll memo answers an `If-None-Match` repeat BEFORE that
 * call, so it must replay the binding itself: the audit snapshot
 * (middleware/audit.ts) and the post-handler request-context propagation
 * (http-middleware.ts) both read `c.get('accountId')`, and the request log's
 * account field is the surface KRTX-468 was diagnosed from. Only a
 * browser-JWT-shaped request can catch the regression: a PAT's auth
 * middleware binds the account itself and masks it.
 *
 * The real session routes run behind a fake auth middleware that reproduces
 * exactly what `jwtPrincipal` puts on the context (userId, userEmail,
 * authType 'supabase' — no accountId, no iamTokenId) and records what each
 * request left on the context after its handler ran.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { projectsApp } from '../projects/lib/app';
import { registerProjectSessionsRoutes } from '../projects/routes/project-sessions';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const SESSION = crypto.randomUUID();

/** What each request left on the context's `accountId`, in request order. */
const seen: Array<string | undefined> = [];

// Registered before the routes, so the middleware wraps them.
projectsApp.use('*', async (c, next) => {
  c.set('userId', USER);
  c.set('userEmail', 'poll-memo-attribution@kortix.test');
  c.set('authType', 'supabase');
  await next();
  seen.push(c.get('accountId'));
});
registerProjectSessionsRoutes();

/** The response's ETag, failing the test loudly if it is missing. */
function requireEtag(res: Response): string {
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('the session list response carried no ETag');
  return etag;
}

const listUrl = () => `/${PROJECT}/sessions?limit=50&q=account`;

beforeAll(async () => {
  await db.execute(sql`
    insert into kortix.accounts (account_id, name)
    values (${ACCOUNT}, 'poll-memo-attribution')
    on conflict (account_id) do nothing`);
  await db.execute(sql`
    insert into kortix.account_members (user_id, account_id, account_role)
    values (${USER}, ${ACCOUNT}, 'owner')
    on conflict do nothing`);
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url)
    values (${PROJECT}, ${ACCOUNT}, 'poll-memo-attribution', 'https://github.com/kortix-ai/suna')
    on conflict (project_id) do nothing`);
  await db.execute(sql`
    insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, created_by, visibility, created_at, updated_at)
    values (${SESSION}, ${ACCOUNT}, ${PROJECT}, 'poll-memo-attr', ${USER}, 'project', now() - interval '1 minutes', now() - interval '1 minutes')
    on conflict (session_id) do nothing`);
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.projects where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.account_members where account_id = ${ACCOUNT}`);
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
});

describe('a memoized 304 keeps the computed path account binding', () => {
  // Pin the clock inside the 2 s memo window before the repeat: under the
  // full run's parallel lanes the wall time between the seed and the repeat
  // can exceed the TTL, where a recompute binds the account too and the test
  // would pass without exercising the replay at all.
  afterEach(() => setSystemTime());

  test('the computed GET binds the account and the memoized 304 replays it', async () => {
    const first = await projectsApp.request(listUrl());
    expect(first.status).toBe(200);
    const etag = requireEtag(first);
    // The computed path: `loadProjectForUser` bound the account on the
    // context, exactly as it does for every real browser-JWT poll.
    expect(seen[0]).toBe(ACCOUNT);

    setSystemTime(new Date(Date.now() - 1_000));
    const repeat = await projectsApp.request(listUrl(), {
      headers: { 'If-None-Match': etag },
    });
    expect(repeat.status).toBe(304);
    // THE CONTRACT: the memoized 304 skips `loadProjectForUser`, so the peek
    // must replay the binding. Without the replay the context carries no
    // account and both the audit snapshot and the request log lose the
    // attribution on every memoized poll.
    expect(seen[1]).toBe(ACCOUNT);
  });
});
