import { ProjectSessionSchema } from '@kortix/api-contract';
/**
 * Integration test (real DB, real route): the session list must survive a
 * response that was finalized on its context MID-HANDLER — KRTX-2736.
 *
 * In prod (Better Stack patterns 8a0ce853… / 68b357d5…, 2026-10-17,
 * GET /v1/projects/:id/sessions, both the JWT and the PAT auth paths) the
 * handler reached its final block with `c.finalized === true` and a
 * locked-and-disturbed ReadableStream as the context response's body. The
 * final block's `c.header('Cache-Control', …)` then re-wrapped that body
 * (`Context.header` → `createResponseInstance(this.#res.body, this.#res)` =
 * `new Response(<disturbed stream>, …)`) and Bun threw
 * `TypeError: Body object should not be disturbed or locked` — an unattributed
 * 500 on a poll the dashboard retries.
 *
 * The middleware below replays that state deliberately: it puts a Response
 * whose body is a ReadableStream on the context and then reads (disturbs) the
 * stream, before the route runs. That is exactly the context state the prod
 * handler saw. Without the fix the handler's post-hoc `c.header` calls throw
 * the exact prod TypeError; with it the headers are part of the response
 * built at construction and the handler's own response wins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { projectsApp } from '../projects/lib/app';
import { registerProjectSessionsRoutes } from '../projects/routes/project-sessions';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const SESSIONS = 6;

/** The exact context state the prod handler saw (KRTX-2736). */
function finalizeWithDisturbedStream(c: Context): void {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2048).fill(65));
      controller.close();
    },
  });
  // Assign while the body is still clean (the `c.res` setter re-wraps the
  // previous body only when one already exists, so this lands as-is), then
  // lock and read the stream that now backs the context response.
  c.res = new Response(stream, { status: 200 });
  const reader = c.res.body!.getReader(); // LOCK
  void reader.read(); // DISTURB
}

// Scoped to THIS test's project id: other test files share this app instance
// in one bun test process, and their requests must not be touched.
projectsApp.use('*', async (c, next) => {
  c.set('userId', USER);
  c.set('userEmail', 'krtx2736@kortix.test');
  c.set('authType', 'supabase');
  if (c.req.path === `/${PROJECT}/sessions`) {
    finalizeWithDisturbedStream(c);
  }
  await next();
});
registerProjectSessionsRoutes();

beforeAll(async () => {
  await db.execute(sql`
    insert into kortix.accounts (account_id, name)
    values (${ACCOUNT}, 'krtx2736-disturbed')
    on conflict (account_id) do nothing`);
  await db.execute(sql`
    insert into kortix.account_members (user_id, account_id, account_role)
    values (${USER}, ${ACCOUNT}, 'owner')
    on conflict do nothing`);
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url)
    values (${PROJECT}, ${ACCOUNT}, 'krtx2736-disturbed', 'https://github.com/kortix-ai/suna')
    on conflict (project_id) do nothing`);
  const values = Array.from(
    { length: SESSIONS },
    (_, i) => sql`(${crypto.randomUUID()}, ${ACCOUNT}, ${PROJECT}, ${'krtx2736-' + i}, ${USER}, 'project', now() - interval '1 minutes', now() - interval '1 minutes')`,
  );
  await db.execute(sql`
    insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, created_by, visibility, created_at, updated_at)
    values ${sql.join(values, sql`, `)}
    on conflict (session_id) do nothing`);
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.session_lifecycle_commands where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.projects where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.account_members where account_id = ${ACCOUNT}`);
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
});

describe('KRTX-2736: a mid-handler response finalization cannot disturb the session list', () => {
  test('the computed 200 poll answers with the list, not the prod TypeError', async () => {
    const res = await projectsApp.request(`/${PROJECT}/sessions?limit=20&parent=root`, {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(SESSIONS);
    for (const value of body) {
      const session = ProjectSessionSchema.parse(value);
      expect(session.working).toEqual({ state: 'idle', since: null, turn_token: null, pending_delivery: false });
      const detail = await projectsApp.request(`/${PROJECT}/sessions/${session.session_id}`);
      expect(detail.status).toBe(200);
      const read = ProjectSessionSchema.parse(await detail.json());
      expect(read.working).toEqual(session.working);
      expect(read.status).toBe(session.status);
    }
  });

  test('working inbox query excludes terminal history and held rows and returns only minimal live facts', async () => {
    const { listInboxPromptsForSessions } = await import('../projects/session-lifecycle/inbox-rows');
    const session = await db.execute(sql`select session_id from kortix.project_sessions where project_id = ${PROJECT} limit 1`);
    const sessionId = session[0].session_id;
    const states = [
      ['queued', {}], ['running', { delivery_started_at: 'now' }],
      ['succeeded', { status: 'forwarded' }], ['queued', { held: true }],
      ['succeeded', { status: 'forwarded', held: true }],
      ['failed', { status: 'forwarded' }], ['dead_lettered', {}], ['succeeded', { status: 'delivered' }],
      ['queued', { admission_reason: 'held' }],
      ['succeeded', { status: 'forwarded', admission_reason: 'held' }],
      ['running', { delivery_started_at: 'now', admission_reason: 'held' }],
    ];
    for (const [status, result] of states) {
      await db.execute(sql`insert into kortix.session_lifecycle_commands
        (command_type, source, status, project_id, account_id, session_id, payload, result)
        values ('continue_session', 'test', ${status}, ${PROJECT}, ${ACCOUNT}, ${sessionId},
        ${JSON.stringify({ clientMessageId: 'm', clientSentAtMs: 123, text: 'private prompt', parts: [{ attachment_id: 'large' }] })}::jsonb,
        ${JSON.stringify(result)}::jsonb)`);
    }
    const rows = await listInboxPromptsForSessions([String(sessionId)]);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['client_sent_at_ms', 'reason', 'sessionId', 'state']);
    expect(rows.map(row => row.state).sort()).toEqual(['delivering', 'delivering', 'delivering', 'delivering', 'queued']);
    expect(await listInboxPromptsForSessions([crypto.randomUUID()])).toEqual([]);
  });

  test('the memoized 304 poll carries its headers and stays a 304', async () => {
    // Prime the poll memo with a computed response: disturb the context first,
    // exactly like the failing case above.
    const first = await projectsApp.request(`/${PROJECT}/sessions?limit=20&pinned=only`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const second = await projectsApp.request(`/${PROJECT}/sessions?limit=20&pinned=only`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('private, no-cache');
    expect(second.body).toBeNull();
  });
});
