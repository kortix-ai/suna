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
 *  2. Behave like a real (if minimal) Kortix API: a projects store, secrets,
 *     session cost rows, cli-token minting, and the `/p/...` sandbox-runtime
 *     proxy surface (generic passthrough + one SSE stream + one echoing
 *     "message" endpoint) — enough surface for every flow the whitelabel app
 *     exercises through the BFF proxy.
 */

export interface RecordedRequest {
  method: string;
  path: string; // pathname + search, e.g. "/v1/projects/proj_1"
  authorization: string | null;
  cookie: string | null;
  acceptEncoding: string | null;
  contentLength: string | null;
  transferEncoding: string | null;
  body: unknown;
}

export interface MockProject {
  project_id: string;
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

/** One `/connector-profiles` row — the shape `selectConnectorBindingChoices`
 *  filters. Deliberately the raw upstream shape, not the app's view of it. */
export interface MockConnectionProfile {
  profile_id: string;
  connector_alias: string;
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
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
  /** Directly seed a project into the mock's store (bypassing `/provision`) —
   *  used to simulate a project that exists upstream but this wrapper user
   *  never provisioned, to prove per-user filtering actually filters. */
  seedProject(overrides?: Partial<MockProject>): MockProject;
  seedSessionCosts(projectId: string, rows: MockSessionCostRow[]): void;
  /** Seed the connection profiles `/connector-profiles` returns for a project. */
  seedConnectionProfiles(
    projectId: string,
    profiles: MockConnectionProfile[],
  ): void;
  /** Make GET /v1/usage/session-costs fail for this project id. */
  failSessionCostsFor(projectId: string): void;
  /** Make POST /v1/projects/:id/cli-token return HTTP 200 with a body MISSING
   *  `secret_key` — a malformed success the wrapper must surface as an error,
   *  never as a 200 carrying an undefined token. */
  malformCliTokenFor(projectId: string): void;
  stop(): void;
}

let projectCounter = 0;
let tokenCounter = 0;

export function createMockUpstream(expectedAuthToken: string): MockUpstream {
  const projects = new Map<string, MockProject>();
  const secrets = new Map<string, Array<{ name: string; value?: string }>>();
  const sessionCosts = new Map<string, MockSessionCostRow[]>();
  const connectionProfiles = new Map<string, MockConnectionProfile[]>();
  const failingSessionCostProjects = new Set<string>();
  const malformedCliTokenProjects = new Set<string>();
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();

  let requests: RecordedRequest[] = [];
  let authViolations: RecordedRequest[] = [];
  let cookieViolations: RecordedRequest[] = [];

  function makeProject(overrides: Partial<MockProject> = {}): MockProject {
    projectCounter += 1;
    // UUID-shaped like real Kortix project ids — the app validates ids with
    // isValidProjectId before recording ownership or building upstream URLs,
    // so a non-UUID mock id would be (correctly) rejected.
    const id =
      overrides.project_id ??
      `00000000-0000-4000-8000-${String(projectCounter).padStart(12, '0')}`;
    const now = new Date().toISOString();
    return {
      project_id: id,
      account_id: 'acct_test',
      name: overrides.name ?? `Mock Project ${projectCounter}`,
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
        const projectId = url.searchParams.get('project_id') ?? '';
        if (failingSessionCostProjects.has(projectId)) {
          return Response.json(
            { error: 'session costs unavailable' },
            { status: 500 },
          );
        }
        const rows = sessionCosts.get(projectId) ?? [];
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

      // ── projects: bare collection ──────────────────────────────────────
      if (p === 'projects' && method === 'GET') {
        return Response.json([...projects.values()]);
      }
      if (p === 'projects/provision' && method === 'POST') {
        const reqBody = (body as { name?: string } | undefined) ?? {};
        const project = makeProject({ name: reqBody.name ?? 'New project' });
        projects.set(project.project_id, project);
        return Response.json(project, { status: 201 });
      }

      // ── projects: scoped to one id ──────────────────────────────────────
      const secretsMatch = p.match(/^projects\/([^/]+)\/secrets$/);
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

      const profilesMatch = p.match(/^projects\/([^/]+)\/connector-profiles$/);
      if (profilesMatch && method === 'GET') {
        const [, id] = profilesMatch;
        return Response.json({ profiles: connectionProfiles.get(id) ?? [] });
      }

      const cliTokenMatch = p.match(/^projects\/([^/]+)\/cli-token$/);
      if (cliTokenMatch && method === 'POST') {
        const [, id] = cliTokenMatch;
        tokenCounter += 1;
        if (malformedCliTokenProjects.has(id)) {
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
        /^projects\/([^/]+)\/sessions\/([^/]+)\/start$/,
      );
      if (sessionStartMatch && method === 'POST') {
        const [, projectId, sessionId] = sessionStartMatch;
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
            project_id: projectId,
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

      const projectDetailMatch = p.match(/^projects\/([^/]+)$/);
      if (projectDetailMatch) {
        const [, id] = projectDetailMatch;
        const project = projects.get(id);
        if (method === 'GET') {
          if (!project)
            return Response.json({ error: 'Not found' }, { status: 404 });
          // Deliberately set an upstream cookie here so tests can assert the
          // proxy strips it before it reaches the browser.
          return Response.json(project, {
            headers: { 'set-cookie': 'upstream_session=leak-me; Path=/' },
          });
        }
      }

      // Any other `projects/:id/...` sub-path (sessions, files, connectors, …) —
      // generic forwarded-OK, recorded for assertion.
      if (/^projects\/[^/]+(\/.*)?$/.test(p)) {
        return Response.json({ ok: true, path: p, method });
      }

      // ── executor/projects/:id/... ─────────────────────────────────────
      if (/^executor\/projects\/[^/]+(\/.*)?$/.test(p)) {
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
    seedProject(overrides) {
      const project = makeProject(overrides);
      projects.set(project.project_id, project);
      return project;
    },
    seedSessionCosts(projectId, rows) {
      sessionCosts.set(projectId, rows);
    },
    seedConnectionProfiles(projectId, profiles) {
      connectionProfiles.set(projectId, profiles);
    },
    failSessionCostsFor(projectId) {
      failingSessionCostProjects.add(projectId);
    },
    malformCliTokenFor(projectId) {
      malformedCliTokenProjects.add(projectId);
    },
    stop() {
      for (const interval of activeIntervals) clearInterval(interval);
      activeIntervals.clear();
      server.stop(true);
    },
  };
}
