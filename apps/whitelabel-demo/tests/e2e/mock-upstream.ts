/**
 * Mock Kortix upstream — a tiny `Bun.serve` HTTP server implementing exactly
 * the endpoints `src/app/api/kortix/[...path]/route.ts`,
 * `src/app/api/preview-token/route.ts`, and `src/app/api/usage/route.ts` call
 * out to. Everything is namespaced under `/v1` (matching `KORTIX_UPSTREAM`
 * including its `/v1` suffix, the same shape as `NEXT_PUBLIC_KORTIX_API_URL`).
 *
 * Two jobs beyond serving canned responses:
 *  1. Record every request (method, path, headers, body) so tests can assert
 *     on what actually reached "Kortix" — in particular, that `Authorization`
 *     is ALWAYS `Bearer <the wrapper key>`, never an end-user session token,
 *     and that the wrapper's own `lumen_session` cookie never leaks upstream.
 *  2. Behave like a real (if minimal) Kortix API: a projects store, secrets,
 *     gateway cost rows, cli-token minting, and the `/p/...` sandbox-runtime
 *     proxy surface (generic passthrough + one SSE stream + one echoing
 *     "message" endpoint) — enough surface for every flow the whitelabel app
 *     exercises through the BFF proxy.
 */

export interface RecordedRequest {
  method: string;
  path: string; // pathname + search, e.g. "/v1/projects/proj_1"
  authorization: string | null;
  cookie: string | null;
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

export interface GatewaySessionRow {
  session_id: string;
  total_cost: number;
  [key: string]: unknown;
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
  seedGatewaySessions(projectId: string, rows: GatewaySessionRow[]): void;
  /** Make GET /v1/projects/:id/gateway/sessions fail (500) for this project id. */
  failGatewayFor(projectId: string): void;
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
  const gatewaySessions = new Map<string, GatewaySessionRow[]>();
  const failingGatewayProjects = new Set<string>();
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
      overrides.project_id ?? `00000000-0000-4000-8000-${String(projectCounter).padStart(12, '0')}`;
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
        contentLength,
        transferEncoding,
        body,
      };
      requests.push(entry);
      if (authorization !== `Bearer ${expectedAuthToken}`) authViolations.push(entry);
      if (cookie) cookieViolations.push(entry);

      const p = url.pathname.replace(/^\/v1\//, '');

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
          const entryBody = body as { name?: string; value?: string } | undefined;
          if (entryBody?.name) list.push({ name: entryBody.name, value: entryBody.value });
          secrets.set(id, list);
          return Response.json({ ok: true });
        }
      }

      const gatewayMatch = p.match(/^projects\/([^/]+)\/gateway\/sessions$/);
      if (gatewayMatch && method === 'GET') {
        const [, id] = gatewayMatch;
        if (failingGatewayProjects.has(id)) {
          return Response.json({ error: 'gateway unavailable' }, { status: 500 });
        }
        return Response.json({ sessions: gatewaySessions.get(id) ?? [] });
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

      const projectDetailMatch = p.match(/^projects\/([^/]+)$/);
      if (projectDetailMatch) {
        const [, id] = projectDetailMatch;
        const project = projects.get(id);
        if (method === 'GET') {
          if (!project) return Response.json({ error: 'Not found' }, { status: 404 });
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
      const sseMatch = p.match(/^p\/([^/]+)\/(\d+)\/global\/event$/);
      if (sseMatch && method === 'GET') {
        let interval: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            let n = 0;
            const push = (data: unknown) => {
              controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
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

      return Response.json({ error: 'mock-upstream: no route', path: p, method }, { status: 404 });
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
    seedGatewaySessions(projectId, rows) {
      gatewaySessions.set(projectId, rows);
    },
    failGatewayFor(projectId) {
      failingGatewayProjects.add(projectId);
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
