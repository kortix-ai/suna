/**
 * Per-end-user metering and the two guardrail probes on `/api/usage`.
 *
 * This file carries its OWN mock upstream rather than reusing
 * `mock-upstream.ts`: the shared mock deliberately answers `/usage` and session
 * create with generic canned responses, and everything asserted here is about
 * the exact query string that went out and the exact `code` that came back.
 * A mock that cannot distinguish `?group_by=end_user_ref` from
 * `?end_user_ref=<me>` could not fail these tests.
 *
 * The app boots twice — once with no operator configured (the default: the
 * grouped read is narrowed to the caller) and once with
 * `LUMEN_USAGE_SHOW_ACCOUNT_BREAKDOWN=1` (the account-wide view).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { DEMO_PASSWORD, wrapperEnv, WRAPPER_KEY } from './env';
import {
  classifyCapProbe,
  classifyIdempotencyProbe,
  type ProbeAttempt,
  type ProbeResponse,
  type UsageResponse,
} from '../../src/app/usage/contract';

// ── A mock upstream that actually reads the query string ─────────────────────

interface UsageRow {
  endUserRef: string | null;
  cost: number;
  count: number;
}

interface CapRefusal {
  code: string;
  error: string;
}

interface Upstream {
  url: string;
  requests: Array<{ method: string; path: string }>;
  seedUsage(rows: UsageRow[]): void;
  /** Make `GET /v1/usage` fail for calls carrying this exact query fragment. */
  failUsageMatching(fragment: string): void;
  capFor(projectId: string, refusal: CapRefusal): void;
  stop(): void;
}

function createUpstream(expectedToken: string): Upstream {
  const projects = new Set<string>();
  const requests: Array<{ method: string; path: string }> = [];
  let usageRows: UsageRow[] = [];
  const usageFailures = new Set<string>();
  const caps = new Map<string, CapRefusal>();
  // idempotency-key → the create it claimed, exactly as the real engine keys it.
  const claimed = new Map<string, { sessionId: string; runtimeContext: string }>();
  let counter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      requests.push({ method, path: `${url.pathname}${url.search}` });

      if (req.headers.get('authorization') !== `Bearer ${expectedToken}`) {
        return Response.json({ error: 'bad token' }, { status: 401 });
      }

      let body: Record<string, unknown> = {};
      if (method !== 'GET' && method !== 'HEAD') {
        const text = await req.text();
        try {
          const parsed: unknown = text ? JSON.parse(text) : {};
          if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
        } catch {
          body = {};
        }
      }

      const p = url.pathname.replace(/^\/v1\//, '');

      if (p === 'projects/provision' && method === 'POST') {
        counter += 1;
        const id = `00000000-0000-4000-9000-${String(counter).padStart(12, '0')}`;
        projects.add(id);
        return Response.json({ project_id: id, name: body.name ?? 'p' }, { status: 201 });
      }

      const gateway = p.match(/^projects\/([^/]+)\/gateway\/sessions$/);
      if (gateway && method === 'GET') return Response.json({ sessions: [] });

      if (p === 'usage' && method === 'GET') {
        for (const fragment of usageFailures) {
          if (url.search.includes(fragment)) {
            return Response.json({ error: 'usage unavailable' }, { status: 500 });
          }
        }
        const groupBy = url.searchParams.get('group_by');
        const narrow = url.searchParams.get('end_user_ref');
        const matching = narrow ? usageRows.filter((r) => r.endUserRef === narrow) : usageRows;
        const data = {
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cached_tokens: 0,
          total_cache_write_tokens: 0,
          total_cost: matching.reduce((sum, r) => sum + r.cost, 0),
          count: matching.reduce((sum, r) => sum + r.count, 0),
        };
        if (groupBy !== 'end_user_ref') return Response.json({ data });
        // Upstream EXCLUDES null-ref rows from this grouping — that exclusion is
        // the whole reason the rows don't sum to the total.
        const breakdown = matching
          .filter((r) => r.endUserRef !== null)
          .map((r) => ({
            end_user_ref: r.endUserRef,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cost: r.cost,
            count: r.count,
          }));
        return Response.json({ data, breakdown });
      }

      const create = p.match(/^projects\/([^/]+)\/sessions$/);
      if (create && method === 'POST') {
        const [, projectId] = create;
        const cap = caps.get(projectId);
        if (cap) return Response.json(cap, { status: 429 });

        const key = req.headers.get('idempotency-key');
        const runtimeContext = JSON.stringify(body.runtime_context ?? null);
        if (key) {
          const existing = claimed.get(key);
          if (existing) {
            if (existing.runtimeContext !== runtimeContext) {
              return Response.json(
                {
                  error: 'Idempotency key was already used with a different runtime_context',
                  code: 'IDEMPOTENCY_CONTEXT_CONFLICT',
                },
                { status: 409 },
              );
            }
            return Response.json({ session_id: existing.sessionId }, { status: 201 });
          }
        }
        counter += 1;
        const sessionId = `sess_${counter}`;
        if (key) claimed.set(key, { sessionId, runtimeContext });
        return Response.json({ session_id: sessionId }, { status: 201 });
      }

      return Response.json({ error: 'no route', path: p }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    seedUsage(rows) {
      usageRows = rows;
    },
    failUsageMatching(fragment) {
      usageFailures.add(fragment);
    },
    capFor(projectId, refusal) {
      caps.set(projectId, refusal);
    },
    stop() {
      server.stop(true);
    },
  };
}

async function provision(app: AppInstance, token: string, name: string): Promise<string> {
  const project = await createTestKortix(app, token).projects.provision({ name });
  return project.project_id;
}

async function getUsage(app: AppInstance, token: string): Promise<UsageResponse> {
  const res = await fetch(`${app.baseUrl}/api/usage`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as UsageResponse;
}

async function runProbe(
  app: AppInstance,
  token: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: ProbeResponse & { error?: string } }> {
  const res = await fetch(`${app.baseUrl}/api/usage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as ProbeResponse & { error?: string } };
}

// ── The grouped/narrowed reads ───────────────────────────────────────────────

describe('/api/usage — per-end-user metering', () => {
  let upstream: Upstream;
  let app: AppInstance;
  let operatorApp: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    upstream = createUpstream(WRAPPER_KEY);
    const env = { KORTIX_UPSTREAM: `${upstream.url}/v1` };
    app = await startApp(wrapperEnv(env));
    operatorApp = await startApp(wrapperEnv({ ...env, LUMEN_USAGE_SHOW_ACCOUNT_BREAKDOWN: '1' }));
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await operatorApp?.stop();
    upstream?.stop();
    resetUsersStore();
  });

  test('the grouped call goes out as group_by=end_user_ref, narrowed to the caller by default', async () => {
    const email = uniqueEmail('usage-grouped');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    upstream.seedUsage([{ endUserRef: email, cost: 4, count: 2 }]);

    const before = upstream.requests.length;
    const data = await getUsage(app, token);
    const sent = upstream.requests.slice(before).map((r) => r.path);

    const grouped = sent.find((path) => path.includes('group_by=end_user_ref'));
    expect(grouped).toBeTruthy();
    expect(grouped).toContain(`end_user_ref=${encodeURIComponent(email)}`);
    // The narrowed "what does THIS end-user owe me" read is a separate call.
    expect(
      sent.some((path) => path.includes('end_user_ref=') && !path.includes('group_by=')),
    ).toBe(true);

    expect(data.endUserRef).toBe(email);
    expect(data.operator).toBe(false);
    expect(data.scope).toBe('self');
    expect(data.mine).toEqual({ rawCost: 4, billedCost: 6, sessions: 2 });
    expect(data.by_end_user).toEqual([
      { endUserRef: email, rawCost: 4, billedCost: 6, sessions: 2 },
    ]);
  });

  test('a non-operator never gets the account total or another end-user’s row', async () => {
    const mine = uniqueEmail('usage-selfscope');
    const token = await loginUser(app, mine, DEMO_PASSWORD);
    upstream.seedUsage([
      { endUserRef: mine, cost: 1, count: 1 },
      { endUserRef: 'someone-else@example.test', cost: 99, count: 9 },
    ]);

    const data = await getUsage(app, token);
    expect(data.by_end_user.map((b) => b.endUserRef)).toEqual([mine]);
    expect(data.accountTotal).toBeNull();
    // Not computable without an account total — and `null` must NOT read as "nothing missing".
    expect(data.unattributed_cost).toBeNull();
  });

  test('an operator sees every row, and the rows deliberately do not sum to the total', async () => {
    const email = uniqueEmail('usage-operator');
    const token = await loginUser(operatorApp, email, DEMO_PASSWORD);
    upstream.seedUsage([
      { endUserRef: email, cost: 3, count: 1 },
      { endUserRef: 'other@example.test', cost: 5, count: 2 },
      // No end_user_ref: a dashboard session. In the total, out of the grouping.
      { endUserRef: null, cost: 7, count: 4 },
    ]);

    const before = upstream.requests.length;
    const data = await getUsage(operatorApp, token);
    const grouped = upstream.requests
      .slice(before)
      .map((r) => r.path)
      .find((path) => path.includes('group_by=end_user_ref'));

    // Account-wide grouping is NOT narrowed.
    expect(grouped).toBeTruthy();
    expect(grouped).not.toContain('end_user_ref=');

    expect(data.operator).toBe(true);
    expect(data.scope).toBe('account');
    expect(data.accountTotal?.rawCost).toBe(15);
    expect(data.by_end_user.map((b) => b.rawCost).reduce((a, b) => a + b, 0)).toBe(8);
    // 15 counted, 8 attributed — the 7 with no end_user_ref is the gap the UI warns about.
    expect(data.unattributed_cost).toBe(7);
  });

  test('an unreadable rollup is reported as an error, never as zero', async () => {
    const email = uniqueEmail('usage-broken');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    upstream.seedUsage([{ endUserRef: email, cost: 2, count: 1 }]);
    upstream.failUsageMatching('group_by=end_user_ref');

    const data = await getUsage(app, token);
    expect(data.groupedError).toBeTruthy();
    expect(data.by_end_user).toEqual([]);
    // The narrowed read is a different call and must survive the grouped one failing.
    expect(data.mineError).toBeNull();
    expect(data.mine?.rawCost).toBe(2);
  });
});

// ── The guardrail probes ─────────────────────────────────────────────────────

describe('/api/usage — caps and idempotency probes', () => {
  let upstream: Upstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    upstream = createUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${upstream.url}/v1` }));
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    upstream?.stop();
    resetUsersStore();
  });

  test('a 429 surfaces its specific cap code, not a generic failure', async () => {
    const email = uniqueEmail('caps-spend');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Caps');
    upstream.capFor(projectId, {
      code: 'per_end_user_spend_limit',
      error: 'This end-user has spent $12.50 in the last 30 days (limit $10.00).',
    });

    const { status, body } = await runProbe(app, token, { probe: 'caps', projectId });
    expect(status).toBe(200);
    expect(body.attempts[0].status).toBe(429);
    expect(body.verdict.kind).toBe('cap');
    expect(body.verdict.code).toBe('per_end_user_spend_limit');
    expect(body.verdict.title).toContain('Spend cap');
    // The server's own numbers are passed through, not replaced with filler.
    expect(body.verdict.detail).toContain('$12.50');
  });

  test('the concurrency cap reads differently from the spend cap', async () => {
    const email = uniqueEmail('caps-concurrency');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Caps 2');
    upstream.capFor(projectId, {
      code: 'per_origin_session_limit',
      error: 'This end-user already has 1 active session (limit 1).',
    });

    const { body } = await runProbe(app, token, { probe: 'caps', projectId });
    expect(body.verdict.code).toBe('per_origin_session_limit');
    expect(body.verdict.title).toContain('Concurrency');
  });

  test('no cap configured reads as "no cap fired", not as "there is no cap"', async () => {
    const email = uniqueEmail('caps-off');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Caps Off');

    const { body } = await runProbe(app, token, { probe: 'caps', projectId });
    expect(body.verdict.kind).toBe('created');
    expect(body.verdict.detail).toContain('off by default');
  });

  test('an idempotent replay returns the SAME session', async () => {
    const email = uniqueEmail('idem-replay');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Idem Replay');

    const { body } = await runProbe(app, token, {
      probe: 'idempotency',
      projectId,
      variant: 'replay',
    });
    expect(body.attempts).toHaveLength(2);
    // One key, sent on both attempts — that is the property being demonstrated.
    expect(body.attempts[0].idempotencyKey).toBe(body.attempts[1].idempotencyKey);
    expect(body.attempts[0].idempotencyKey).toBeTruthy();
    expect(body.attempts[1].sessionId).toBe(body.attempts[0].sessionId);
    expect(body.verdict.kind).toBe('replayed');
    expect(body.verdict.title).toContain('Same session');
  });

  test('a replay with a different body renders the 409 conflict, distinctly', async () => {
    const email = uniqueEmail('idem-conflict');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Idem Conflict');

    const { body } = await runProbe(app, token, {
      probe: 'idempotency',
      projectId,
      variant: 'conflict',
    });
    expect(body.attempts[0].status).toBe(201);
    expect(body.attempts[1].status).toBe(409);
    expect(body.verdict.kind).toBe('conflict');
    expect(body.verdict.code).toBe('IDEMPOTENCY_CONTEXT_CONFLICT');
    // The two outcomes must not collapse into one word.
    expect(body.verdict.kind).not.toBe('replayed');
  });

  test('every probe stamps end_user_ref server-side from the session', async () => {
    const email = uniqueEmail('idem-endusr');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Idem Ref');

    const { body } = await runProbe(app, token, { probe: 'caps', projectId });
    expect(body.endUserRef).toBe(email);
    expect(body.attempts[0].sentBody.end_user_ref).toBe(email);
  });

  test('a project the caller does not own is refused before any upstream call', async () => {
    const owner = uniqueEmail('idem-owner');
    const ownerToken = await loginUser(app, owner, DEMO_PASSWORD);
    const projectId = await provision(app, ownerToken, 'Someone Else');

    const intruderToken = await loginUser(app, uniqueEmail('idem-intruder'), DEMO_PASSWORD);
    const before = upstream.requests.length;
    const { status } = await runProbe(app, intruderToken, { probe: 'caps', projectId });
    expect(status).toBe(403);
    expect(upstream.requests.length).toBe(before);
  });

  test('an unknown probe name is rejected rather than guessed at', async () => {
    const token = await loginUser(app, uniqueEmail('idem-bad'), DEMO_PASSWORD);
    const { status } = await runProbe(app, token, { probe: 'whatever', projectId: 'x' });
    expect(status).toBe(400);
  });
});

// ── The pure verdicts the two panels render ──────────────────────────────────

function attempt(overrides: Partial<ProbeAttempt> = {}): ProbeAttempt {
  return {
    label: 'create',
    status: 201,
    code: null,
    message: null,
    sessionId: 'sess_1',
    idempotencyKey: 'k',
    sentBody: {},
    ...overrides,
  };
}

describe('probe verdicts', () => {
  test('each cap code gets its own words', () => {
    expect(classifyCapProbe(attempt({ status: 429, code: 'per_origin_session_limit' })).title).toBe(
      'Concurrency cap fired',
    );
    expect(classifyCapProbe(attempt({ status: 429, code: 'per_end_user_spend_limit' })).title).toBe(
      'Spend cap fired',
    );
    expect(classifyCapProbe(attempt({ status: 429, code: 'concurrent_session_limit' })).title).toBe(
      'Account-wide capacity cap fired',
    );
  });

  test('a non-cap refusal is not dressed up as a cap', () => {
    const verdict = classifyCapProbe(attempt({ status: 400, code: 'INVALID_SESSION_MODEL' }));
    expect(verdict.kind).toBe('refused');
    expect(verdict.code).toBe('INVALID_SESSION_MODEL');
  });

  test('a replay that quietly created a SECOND session is called out, not celebrated', () => {
    const verdict = classifyIdempotencyProbe(
      attempt({ sessionId: 'sess_1' }),
      attempt({ sessionId: 'sess_2' }),
    );
    expect(verdict.kind).toBe('not-idempotent');
    expect(verdict.title).toContain('SECOND');
  });

  test('a failed FIRST create blames the first create, not the replay', () => {
    const verdict = classifyIdempotencyProbe(
      attempt({ status: 429, code: 'per_end_user_spend_limit', message: 'over budget' }),
      attempt({ status: 409, code: 'IDEMPOTENCY_CONTEXT_CONFLICT' }),
    );
    expect(verdict.kind).toBe('cap');
    expect(verdict.detail).toContain('FIRST create never succeeded');
  });

  test('every IDEMPOTENCY_* refusal reads as a conflict, not as a generic error', () => {
    for (const code of [
      'IDEMPOTENCY_BINDING_CONFLICT',
      'IDEMPOTENCY_SECRETS_CONFLICT',
      'IDEMPOTENCY_ORIGIN_CONFLICT',
      'IDEMPOTENCY_CONTEXT_CONFLICT',
      'IDEMPOTENCY_REQUIRE_CONNECTORS_CONFLICT',
      'IDEMPOTENCY_KEY_CONFLICT',
      'IDEMPOTENCY_KEY_SESSION_DELETED',
    ]) {
      const verdict = classifyIdempotencyProbe(attempt(), attempt({ status: 409, code }));
      expect(verdict.kind).toBe('conflict');
      expect(verdict.code).toBe(code);
    }
  });
});
