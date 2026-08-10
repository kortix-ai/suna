/**
 * Mock Kortix upstream — a tiny `Bun.serve` HTTP server implementing exactly
 * the endpoints `src/app/api/kortix/[...path]/route.ts`,
 * `src/app/api/preview-url/route.ts`, and `src/app/api/session-costs/route.ts` call
 * out to. Everything is namespaced under `/v1` (matching `KORTIX_UPSTREAM`
 * including its `/v1` suffix, the same shape as `NEXT_PUBLIC_KORTIX_API_URL`).
 *
 * Two jobs beyond serving canned responses:
 *  1. Record every request (method, path, headers, body) so tests can assert
 *     on what actually reached "Kortix" — in particular, that `Authorization`
 *     is ALWAYS `Bearer <the wrapper key>`, never an end-user session token,
 *     and that the wrapper's own `lumen_session` cookie never leaks upstream.
 *  2. Behave like a real (if minimal) Kortix API: a workspaces store, secrets,
 *     session cost rows, cli-token minting, and the `/p/...` sandbox-runtime
 *     proxy surface (generic passthrough + one SSE stream + one echoing
 *     "message" endpoint) — enough surface for every flow the whitelabel app
 *     exercises through the BFF proxy.
 */

export interface RecordedRequest {
  method: string;
  path: string; // pathname + search, e.g. "/v1/workspaces/proj_1"
  authorization: string | null;
  cookie: string | null;
  acceptEncoding: string | null;
  contentLength: string | null;
  transferEncoding: string | null;
  body: unknown;
}

export interface MockWorkspace {
  workspace_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface MockSessionCostRow {
  session_id: string;
  total_cost: number;
  [key: string]: unknown;
}

/** One `/connections` row — the shape `selectConnectorBindingChoices`
 *  filters. Deliberately the raw upstream shape, not the app's view of it. */
export interface MockConnection {
  connection_id: string;
  connector_alias: string;
  owner_type: 'workspace' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  label: string;
  status: 'active' | 'revoked' | 'error';
  is_default: boolean;
  metadata: Record<string, unknown>;
}

export interface MockUpstream {
  /** Base URL WITHOUT `/v1` — pass `${url}/v1` as `KORTIX_UPSTREAM`. */
  url: string;
  requests: RecordedRequest[];
  /** Any request whose Authorization header didn't match the expected wrapper key. */
  authViolations: RecordedRequest[];
  /** Any request that carried a `Cookie` header (the proxy should always strip it). */
  cookieViolations: RecordedRequest[];
  reset(): void;
  /** Directly seed a workspace into the mock's store (bypassing `/provision`) —
   *  used to simulate a workspace that exists upstream but this wrapper user
   *  never provisioned, to prove per-user filtering actually filters. */
  seedWorkspace(overrides?: Partial<MockWorkspace>): MockWorkspace;
  seedSessionCosts(workspaceId: string, rows: MockSessionCostRow[]): void;
  /** Seed the connections `/connections` returns for a workspace. */
  seedConnections(
    workspaceId: string,
    connections: MockConnection[],
  ): void;
  /** Make GET /v1/usage/session-costs fail for this workspace id. */
  failSessionCostsFor(workspaceId: string): void;
  /** Make POST /v1/workspaces/:id/cli-token return HTTP 200 with a body MISSING
   *  `secret_key` — a malformed success the wrapper must surface as an error,
   *  never as a 200 carrying an undefined token. */
  malformCliTokenFor(workspaceId: string): void;
  stop(): void;
}

let workspaceCounter = 0;
let tokenCounter = 0;

export function createMockUpstream(expectedAuthToken: string): MockUpstream {
  const workspaces = new Map<string, MockWorkspace>();
  const secrets = new Map<string, Array<{ name: string; value?: string }>>();
  const sessionCosts = new Map<string, MockSessionCostRow[]>();
  const connections = new Map<string, MockConnection[]>();
  const failingSessionCostWorkspaces = new Set<string>();
  const malformedCliTokenWorkspaces = new Set<string>();
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();

  let requests: RecordedRequest[] = [];
  let authViolations: RecordedRequest[] = [];
  let cookieViolations: RecordedRequest[] = [];

  function makeWorkspace(overrides: Partial<MockWorkspace> = {}): MockWorkspace {
    workspaceCounter += 1;
    // UUID-shaped like real Kortix workspace ids — the app validates ids with
    // isValidWorkspaceId before recording ownership or building upstream URLs,
    // so a non-UUID mock id would be (correctly) rejected.
    const id =
      overrides.workspace_id ??
      `00000000-0000-4000-8000-${String(workspaceCounter).padStart(12, '0')}`;
    const now = new Date().toISOString();
    return {
      workspace_id: id,
      account_id: 'acct_test',
      name: overrides.name ?? `Mock Workspace ${workspaceCounter}`,
      repo_url: `https://git.kortix.test/${id}`,
      default_branch: 'main',
      manifest_path: 'kortix.yaml',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  function legacyProject(workspace: MockWorkspace): Record<string, unknown> {
    const { workspace_id: project_id, ...rest } = workspace;
    return { ...rest, project_id };
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0, // long-lived SSE connections must not be killed by Bun's idle timeout
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const authorization = req.headers.get('authorization');
      const cookie = req.headers.get('cookie');
      const acceptEncoding = req.headers.get('accept-encoding');
      const contentLength = req.headers.get('content-length');
      const transferEncoding = req.headers.get('transfer-encoding');

      let body: unknown = undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const text = await req.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
      }

      const entry: RecordedRequest = {
        method,
        path: `${url.pathname}${url.search}`,
        authorization,
        cookie,
        acceptEncoding,
        contentLength,
        transferEncoding,
        body,
      };
      requests.push(entry);
      if (authorization !== `Bearer ${expectedAuthToken}`)
        authViolations.push(entry);
      if (cookie) cookieViolations.push(entry);

      const p = url.pathname.replace(/^\/v1\//, '');

      if (p === 'usage/session-costs' && method === 'GET') {
        const workspaceId = url.searchParams.get('workspace_id') ?? '';
        if (failingSessionCostWorkspaces.has(workspaceId)) {
          return Response.json(
            { error: 'session costs unavailable' },
            { status: 500 },
          );
        }
        const rows = sessionCosts.get(workspaceId) ?? [];
        return Response.json({
          sessions: rows,
          total: rows.length,
          limit: Number(url.searchParams.get('limit') ?? 100),
          offset: Number(url.searchParams.get('offset') ?? 0),
          next_offset: null,
          reconciliation: {
            llm_cost: 0,
            compute_cost: 0,
            total_cost: 0,
            request_count: 0,
            compute_window_count: 0,
            compute_seconds: 0,
          },
        });
      }

      // ── workspaces: bare collection ──────────────────────────────────────
      if (p === 'workspaces' && method === 'GET') {
        return Response.json([...workspaces.values()]);
      }
      if (p === 'workspaces/provision' && method === 'POST') {
        const reqBody = (body as { name?: string } | undefined) ?? {};
        const workspace = makeWorkspace({ name: reqBody.name ?? 'New workspace' });
        workspaces.set(workspace.workspace_id, workspace);
        return Response.json(workspace, { status: 201 });
      }

      // Deprecated Project aliases remain a wire-shape compatibility boundary.
      if (p === 'projects' && method === 'GET') {
        return Response.json([...workspaces.values()].map(legacyProject));
      }
      if (p === 'projects/provision' && method === 'POST') {
        const reqBody = (body as { name?: string } | undefined) ?? {};
        const workspace = makeWorkspace({ name: reqBody.name ?? 'New workspace' });
        workspaces.set(workspace.workspace_id, workspace);
        return Response.json(legacyProject(workspace), { status: 201 });
      }

      // ── workspaces: scoped to one id ──────────────────────────────────────
      const secretsMatch = p.match(/^workspaces\/([^/]+)\/secrets$/);
      if (secretsMatch) {
        const [, id] = secretsMatch;
        if (method === 'GET') return Response.json(secrets.get(id) ?? []);
        if (method === 'POST' || method === 'PUT') {
          const list = secrets.get(id) ?? [];
          const entryBody = body as
            { name?: string; value?: string } | undefined;
          if (entryBody?.name)
            list.push({ name: entryBody.name, value: entryBody.value });
          secrets.set(id, list);
          return Response.json({ ok: true });
        }
      }

      const connectionsMatch = p.match(/^workspaces\/([^/]+)\/connections$/);
      if (connectionsMatch && method === 'GET') {
        const [, id] = connectionsMatch;
        return Response.json({ connections: connections.get(id) ?? [] });
      }

      const cliTokenMatch = p.match(/^workspaces\/([^/]+)\/cli-token$/);
      if (cliTokenMatch && method === 'POST') {
        const [, id] = cliTokenMatch;
        tokenCounter += 1;
        if (malformedCliTokenWorkspaces.has(id)) {
          // HTTP 200 but no `secret_key` — the route must NOT pass this
          // through as a success.
          return Response.json({ token_id: `tok_${tokenCounter}` });
        }
        return Response.json({
          secret_key: `kortix_pat_test_${id}_${tokenCounter}`,
          token_id: `tok_${tokenCounter}`,
        });
      }

      const sessionStartMatch = p.match(
        /^workspaces\/([^/]+)\/sessions\/([^/]+)\/start$/,
      );
      if (sessionStartMatch && method === 'POST') {
        const [, workspaceId, sessionId] = sessionStartMatch;
        const now = new Date().toISOString();
        const externalId = `session-${sessionId}`;
        return Response.json({
          stage: 'ready',
          agent_name: 'kortix',
          retriable: true,
          runtime_transport: 'rest',
          runtime_url: `/p/${externalId}/8000`,
          opencode_session_id: `runtime-${sessionId}`,
          sandbox: {
            sandbox_id: sessionId,
            session_id: sessionId,
            workspace_id: workspaceId,
            account_id: 'acct_test',
            provider: 'daytona',
            external_id: externalId,
            base_url: `/p/${externalId}/8000`,
            status: 'active',
            config: {},
            metadata: {},
            last_used_at: now,
            created_at: now,
            updated_at: now,
          },
        });
      }

      const workspaceDetailMatch = p.match(/^workspaces\/([^/]+)$/);
      if (workspaceDetailMatch) {
        const [, id] = workspaceDetailMatch;
        const workspace = workspaces.get(id);
        if (method === 'GET') {
          if (!workspace)
            return Response.json({ error: 'Not found' }, { status: 404 });
          // Deliberately set an upstream cookie here so tests can assert the
          // proxy strips it before it reaches the browser.
          return Response.json(workspace, {
            headers: { 'set-cookie': 'upstream_session=leak-me; Path=/' },
          });
        }
      }

      const legacyProjectDetailMatch = p.match(/^projects\/([^/]+)$/);
      if (legacyProjectDetailMatch) {
        const [, id] = legacyProjectDetailMatch;
        const workspace = workspaces.get(id);
        if (method === 'GET') {
          if (!workspace)
            return Response.json({ error: 'Not found' }, { status: 404 });
          return Response.json(legacyProject(workspace));
        }
      }

      const sessionsMatch = p.match(/^workspaces\/([^/]+)\/sessions$/);
      if (sessionsMatch && method === 'GET') {
        return Response.json([]);
      }

      // Any other `workspaces/:id/...` sub-path (sessions, files, connectors, …) —
      // generic forwarded-OK, recorded for assertion.
      if (/^workspaces\/[^/]+(\/.*)?$/.test(p)) {
        return Response.json({ ok: true, path: p, method });
      }

      if (/^projects\/[^/]+(\/.*)?$/.test(p)) {
        return Response.json({ ok: true, path: p, method });
      }

      // ── connectors/workspaces/:id/... ────────────────────────────────────
      if (/^connectors\/workspaces\/[^/]+(\/.*)?$/.test(p)) {
        return Response.json({ ok: true, path: p, method });
      }
      if (/^connectors\/projects\/[^/]+(\/.*)?$/.test(p)) {
        return Response.json({ ok: true, path: p, method });
      }

      // ── accounts ─────────────────────────────────────────────────────
      if (p === 'accounts/me' && method === 'GET') {
        return Response.json({ account_id: 'acct_test', name: 'Test Account' });
      }

      // ── sandbox runtime proxy: /p/{sandboxId}/{port}/... ───────────────
      if (/^p\/[^/]+\/8000\/encoding$/.test(p) && method === 'GET') {
        if (acceptEncoding !== 'identity') {
          return Response.json(
            {
              error:
                'wrapper forwarded unsupported response encoding negotiation',
            },
            { status: 502 },
          );
        }
        return Response.json({ ok: true });
      }

      const sseMatch = p.match(/^p\/([^/]+)\/(\d+)\/global\/event$/);
      if (sseMatch && method === 'GET') {
        let interval: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            let n = 0;
            const push = (data: unknown) => {
              controller.enqueue(
                enc.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`),
              );
            };
            // First two "real" events land immediately-ish, then heartbeats —
            // enough to prove the stream is unbuffered end-to-end.
            push({ type: 'status', n: ++n });
            push({ type: 'status', n: ++n });
            interval = setInterval(() => {
              controller.enqueue(enc.encode(`: heartbeat\n\n`));
            }, 200);
            activeIntervals.add(interval);
          },
          cancel() {
            if (interval) {
              clearInterval(interval);
              activeIntervals.delete(interval);
            }
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      const messageMatch = p.match(/^p\/([^/]+)\/(\d+)\/message$/);
      if (messageMatch && method === 'POST') {
        return Response.json({
          role: 'assistant',
          content: `echo: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
        });
      }

      // Any other `/p/...` path — generic forwarded-OK.
      if (/^p\/[^/]+\/\d+(\/.*)?$/.test(p) || p === 'p' || p.startsWith('p/')) {
        return Response.json({ ok: true, path: p, method });
      }

      return Response.json(
        { error: 'mock-upstream: no route', path: p, method },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    get requests() {
      return requests;
    },
    get authViolations() {
      return authViolations;
    },
    get cookieViolations() {
      return cookieViolations;
    },
    reset() {
      requests = [];
      authViolations = [];
      cookieViolations = [];
    },
    seedWorkspace(overrides) {
      const workspace = makeWorkspace(overrides);
      workspaces.set(workspace.workspace_id, workspace);
      return workspace;
    },
    seedSessionCosts(workspaceId, rows) {
      sessionCosts.set(workspaceId, rows);
    },
    seedConnections(workspaceId, connectionRows) {
      connections.set(workspaceId, connectionRows);
    },
    failSessionCostsFor(workspaceId) {
      failingSessionCostWorkspaces.add(workspaceId);
    },
    malformCliTokenFor(workspaceId) {
      malformedCliTokenWorkspaces.add(workspaceId);
    },
    stop() {
      for (const interval of activeIntervals) clearInterval(interval);
      activeIntervals.clear();
      server.stop(true);
    },
  };
}
