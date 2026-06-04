/**
 * Kortix git smart-HTTP reverse proxy.
 *
 * The UNIVERSAL client-facing git origin for every git-backed project. Clients
 * (sandbox daemon, `kortix` CLI, the user's git) clone/push
 *   https://<KORTIX_URL>/v1/git/<projectId>.git
 * authenticating with a Kortix token (sandbox token / account API key / CLI
 * PAT) — never a real host credential. The API authenticates the token,
 * resolves the project's backend, and streams the git protocol to the real
 * upstream (GitHub managed org / a user's own GitHub repo / …)
 * using a short-lived host credential minted server-side.
 *
 * Only the three git smart-HTTP endpoints are proxied:
 *   GET  /info/refs?service=git-upload-pack|git-receive-pack   (ref discovery)
 *   POST /git-upload-pack                                       (clone / fetch)
 *   POST /git-receive-pack                                      (push)
 *
 * Scope: `git-receive-pack` ⇒ write; `git-upload-pack` ⇒ read.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  authorizeGitProxy,
  resolveProjectUpstream,
  type GitProxyAuth,
} from '../projects';
import type { GitScope } from '../projects/git-backends';
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  extractToken,
  normalizeProjectId,
  scopeForService,
} from './parse';
import { makeOpenApiApp } from '../openapi';

export const gitProxyApp = makeOpenApiApp();

/**
 * The git smart-HTTP protocol streams raw binary pack data (pkt-line framed),
 * authenticates via a custom Basic/Bearer credential helper, and returns
 * `application/x-git-*` bodies — none of which map to JSON schemas. These routes
 * are registered purely for OpenAPI VISIBILITY: paths, methods, and generic
 * responses. We deliberately do NOT attach request/response validation
 * (no `c.req.valid`) so the raw transport and auth flow are untouched.
 */
const gitResponses = {
  200: { description: 'git smart-HTTP response (raw application/x-git-* body)' },
  401: {
    description: 'Authentication required / credential helper re-challenge',
    headers: { 'WWW-Authenticate': { schema: { type: 'string' } } },
  },
  403: { description: 'Token not authorized for the requested scope' },
  404: { description: 'Project not found' },
  502: { description: 'No upstream configured / upstream unreachable' },
} as const;

/** Loose path-param doc; handlers keep their own raw param reads + `.git` stripping. */
const projectParam = z.object({
  project: z.string().openapi({
    param: { name: 'project', in: 'path' },
    description: 'Project id, optionally suffixed with `.git`',
    example: 'abc123.git',
  }),
});

/** Ask git to (re)authenticate via the credential helper. */
function unauthorized(c: any, message: string) {
  c.header('WWW-Authenticate', 'Basic realm="Kortix Git"');
  return c.text(message, 401);
}

async function authorize(c: any, projectId: string, scope: GitScope): Promise<GitProxyAuth> {
  const token = extractToken(c.req.header('authorization'));
  if (!token) return { ok: false, status: 401, message: 'authentication required' };
  return authorizeGitProxy(token, projectId, scope);
}

/**
 * Stream a git smart-HTTP request through to the project's real upstream.
 * `suffix` is the fixed git path appended to the upstream repo URL
 * (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`).
 */
async function forward(c: any, projectId: string, scope: GitScope, suffix: string): Promise<Response> {
  const auth = await authorize(c, projectId, scope);
  if (!auth.ok) {
    if (auth.status === 401) return unauthorized(c, auth.message);
    return c.text(auth.message, auth.status);
  }

  const upstream = await resolveProjectUpstream(auth.project, scope);
  if (!upstream || !upstream.url) {
    return c.text('No git upstream is configured for this project', 502);
  }

  const search = new URL(c.req.url).search; // includes leading '?' or ''
  const base = upstream.url.replace(/\/$/, '');
  const target = `${base}${suffix}${search}`;

  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }
  Object.assign(headers, upstream.headers);

  const method = c.req.method;
  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : c.req.raw.body,
      redirect: 'manual',
      // @ts-ignore — Bun extensions: stream the request body, don't decompress.
      duplex: 'half',
      decompress: false,
    });
  } catch (err) {
    console.warn(`[git-proxy] upstream fetch failed for ${projectId}:`, err);
    return c.text('git upstream unreachable', 502);
  }

  const respHeaders = new Headers();
  res.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  return new Response(res.body, { status: res.status, headers: respHeaders });
}

// Ref discovery — scope is determined by the requested service.
gitProxyApp.openapi(
  createRoute({
    method: 'get',
    path: '/{project}/info/refs',
    tags: ['git'],
    summary: 'git smart-HTTP ref discovery (clone/fetch/push negotiation)',
    request: {
      params: projectParam,
      query: z.object({
        service: z
          .enum(['git-upload-pack', 'git-receive-pack'])
          .optional()
          .openapi({ description: 'git service; receive-pack ⇒ write, else read' }),
      }),
    },
    responses: gitResponses,
  }),
  async (c) => {
    const projectId = normalizeProjectId(c.req.param('project'));
    const scope = scopeForService(c.req.query('service'));
    return forward(c, projectId, scope, '/info/refs');
  },
);

// Clone / fetch.
gitProxyApp.openapi(
  createRoute({
    method: 'post',
    path: '/{project}/git-upload-pack',
    tags: ['git'],
    summary: 'git-upload-pack (clone / fetch) — raw pack stream',
    request: { params: projectParam },
    responses: gitResponses,
  }),
  async (c) => {
    const projectId = normalizeProjectId(c.req.param('project'));
    return forward(c, projectId, 'read', '/git-upload-pack');
  },
);

// Push.
gitProxyApp.openapi(
  createRoute({
    method: 'post',
    path: '/{project}/git-receive-pack',
    tags: ['git'],
    summary: 'git-receive-pack (push) — raw pack stream',
    request: { params: projectParam },
    responses: gitResponses,
  }),
  async (c) => {
    const projectId = normalizeProjectId(c.req.param('project'));
    return forward(c, projectId, 'write', '/git-receive-pack');
  },
);
