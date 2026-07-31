/**
 * Approvals + wrapper project access, end to end through a real `next start`.
 *
 * This file brings its own upstream rather than using `mock-upstream.ts`: the
 * shared mock answers every `projects/:id/...` sub-path with a generic 200, and
 * the two things worth proving here are a SESSION-SCOPED audit body and a 403
 * that carries `APPROVAL_REQUIRES_HUMAN`. Both need real bodies and a real
 * status, so they are served here.
 *
 * What this proves is the DEMO's behaviour — that the wrapper reads approvals
 * from the one route that cannot leak across end-users, resolves them at the
 * right path, and renders the human-only refusal as itself. The platform's own
 * enforcement of that refusal is tested upstream, in kortix-api.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  approvalFailure,
  sessionApprovalsView,
} from '../../src/components/workbench/approvals-model';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';
import {
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';

const PROJECT_ID = '00000000-0000-4000-8000-00000000a001';
const SESSION_ID = '00000000-0000-4000-8000-00000000b001';
/** The gate a human resolves normally. */
const PENDING_EXECUTION = '00000000-0000-4000-8000-00000000c001';
/** The gate upstream refuses because the caller is the agent itself. */
const SELF_APPROVAL_EXECUTION = '00000000-0000-4000-8000-00000000c002';

const AGENT_SELF_APPROVAL_MESSAGE =
  'An agent cannot resolve its own approval — a human must approve or deny this';

interface Recorded {
  method: string;
  /** pathname + search. */
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A Kortix upstream that serves exactly the approval surface this slice uses. */
function createApprovalUpstream() {
  const requests: Recorded[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      let body: unknown;
      if (method !== 'GET' && method !== 'HEAD') {
        const text = await req.text();
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
      }
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.get('authorization'),
        body,
      });

      const p = url.pathname.replace(/^\/v1\//, '');
      const now = new Date().toISOString();

      if (p === 'projects/provision' && method === 'POST') {
        return Response.json(
          {
            project_id: PROJECT_ID,
            account_id: 'acct_test',
            name: 'Approvals project',
            repo_url: `https://git.kortix.test/${PROJECT_ID}`,
            default_branch: 'main',
            manifest_path: 'kortix.yaml',
            status: 'active',
            metadata: {},
            created_at: now,
            updated_at: now,
          },
          { status: 201 },
        );
      }

      if (p === `projects/${PROJECT_ID}/sessions` && method === 'GET') {
        return Response.json([]);
      }

      if (
        p === `projects/${PROJECT_ID}/sessions/${SESSION_ID}/audit` &&
        method === 'GET'
      ) {
        return Response.json({
          session_id: SESSION_ID,
          agent: 'support',
          audit_access: true,
          count: 2,
          actions: [
            {
              execution_id: PENDING_EXECUTION,
              action: 'send_message',
              connector_id: 'conn_slack',
              connector: 'slack',
              status: 'pending_approval',
              risk: 'write',
              acted_by: 'user_agent',
              acted_by_email: null,
              resolved_by: null,
              resolved_by_email: null,
              result_summary: null,
              at: now,
              resolved_at: null,
            },
            {
              execution_id: '00000000-0000-4000-8000-00000000c003',
              action: 'list_channels',
              connector_id: 'conn_slack',
              connector: 'slack',
              status: 'ok',
              risk: 'read',
              acted_by: 'user_agent',
              acted_by_email: null,
              resolved_by: null,
              resolved_by_email: null,
              result_summary: null,
              at: now,
              resolved_at: null,
            },
          ],
        });
      }

      const resolveMatch = p.match(/^projects\/([^/]+)\/approvals\/([^/]+)$/);
      if (resolveMatch && method === 'POST') {
        if (resolveMatch[2] === SELF_APPROVAL_EXECUTION) {
          return Response.json(
            {
              error: AGENT_SELF_APPROVAL_MESSAGE,
              code: 'APPROVAL_REQUIRES_HUMAN',
            },
            { status: 403 },
          );
        }
        // The real route now answers a bare { ok: true } — there is no scope to
        // echo back, because a decision covers only the call that asked.
        return Response.json({ ok: true });
      }

      return Response.json({ ok: true, path: p, method });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    reset() {
      requests.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}

describe('approvals + wrapper project access', () => {
  let upstream: ReturnType<typeof createApprovalUpstream>;
  let app: AppInstance;
  let email: string;
  let kortix: ReturnType<typeof createTestKortix>;

  beforeAll(async () => {
    resetUsersStore();
    upstream = createApprovalUpstream();
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${upstream.url}/v1` }));
    email = uniqueEmail('approvals');
    kortix = createTestKortix(app, await loginUser(app, email, DEMO_PASSWORD));
    // Ownership is recorded on provision, and the policy refuses every
    // `projects/{id}/…` call for an id the caller doesn't own — so nothing
    // below is reachable until this runs.
    await kortix.projects.provision({ name: 'Approvals project' });
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    upstream?.stop();
    resetUsersStore();
  });

  test('a pending gate is read from the session-scoped audit, not the project inbox', async () => {
    upstream.reset();

    const view = sessionApprovalsView(
      await kortix.session(PROJECT_ID, SESSION_ID).audit(50),
    );

    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]!.executionId).toBe(PENDING_EXECUTION);
    expect(view.pending[0]!.action).toBe('slack.send_message');
    // The already-settled read call is history, not a second decision to make.
    expect(view.recent.map((r) => r.action)).toEqual(['slack.list_channels']);

    const read = upstream.requests.filter((r) => r.method === 'GET');
    expect(read).toHaveLength(1);
    expect(read[0]!.path).toBe(
      `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/audit?limit=50`,
    );
    // The project-wide inbox would have handed this browser every OTHER
    // end-user's pending execution ids, and an execution id is all the resolve
    // route needs — so it must never be the read the panel makes.
    expect(upstream.requests.some((r) => r.path.includes('/approvals'))).toBe(
      false,
    );
    expect(read[0]!.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
  });

  test('approving posts the decision to the approval route for that execution', async () => {
    upstream.reset();

    await kortix.project(PROJECT_ID).approvals.resolve(PENDING_EXECUTION, 'approve');

    expect(upstream.requests).toHaveLength(1);
    const posted = upstream.requests[0]!;
    expect(posted.method).toBe('POST');
    expect(posted.path).toBe(`/v1/projects/${PROJECT_ID}/approvals/${PENDING_EXECUTION}`);
    expect(posted.body).toEqual({ decision: 'approve' });
    expect(posted.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
  });

  test('denying carries the deny decision, not an absent one', async () => {
    upstream.reset();

    await kortix
      .project(PROJECT_ID)
      .approvals.resolve(PENDING_EXECUTION, 'deny');

    expect(upstream.requests[0]!.body).toEqual({ decision: 'deny' });
  });

  // Inverted deliberately. This used to assert that a standing "always this
  // session" approval sent `scope: 'session'`. That scope was REMOVED: a grant
  // keyed on (session, connector, action) ignores the ARGUMENTS, so approving a
  // send to one recipient silently pre-authorised a send to any other. A
  // decision now covers exactly the call that asked for it, and no caller can
  // widen it.
  test('a decision can never carry a scope that widens it', async () => {
    upstream.reset();

    await kortix.project(PROJECT_ID).approvals.resolve(PENDING_EXECUTION, 'approve');

    const body = upstream.requests[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ decision: 'approve' });
    expect('scope' in body).toBe(false);
  });

  test('403 APPROVAL_REQUIRES_HUMAN survives the proxy and keeps its own meaning', async () => {
    const err = await kortix
      .project(PROJECT_ID)
      .approvals.resolve(SELF_APPROVAL_EXECUTION, 'approve')
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).not.toBeNull();
    expect((err as { status?: number }).status).toBe(403);

    // The whole point: this renders as the human-in-the-loop rule, not as a
    // generic "could not approve" with a retry button that can never work.
    const failure = approvalFailure(err);
    expect(failure.kind).toBe('requires_human');
    expect(failure.detail).toBe(AGENT_SELF_APPROVAL_MESSAGE);
  });

  test('the access panel labels this browser with the identity the server holds', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: {
        authorization: `Bearer ${await loginUser(app, email, DEMO_PASSWORD)}`,
      },
    });

    expect(res.status).toBe(200);
    // The label is the server's own view of the caller — the browser never
    // supplies it, which is exactly what makes it worth printing.
    expect(await res.json()).toEqual({ userId: email });
  });

  test('the session list is forwarded without an attribution filter', async () => {
    upstream.reset();

    await kortix.project(PROJECT_ID).sessions.list();

    expect(upstream.requests).toHaveLength(1);
    const listed = new URL(upstream.requests[0]!.path, 'http://upstream.test');
    expect(listed.search).toBe('');
  });
});
