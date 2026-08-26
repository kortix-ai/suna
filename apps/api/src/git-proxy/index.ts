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
import { deriveRequestContext } from '../iam/cache';
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  extractToken,
  isValidGitProxyProjectId,
  normalizeProjectId,
  scopeForService,
} from './parse';
import { fetchUpstreamBuffered } from './upstream';
import { makeOpenApiApp } from '../openapi';
import { loadGitProject } from '../projects/lib/git';
import { kickProjectWarmPrebake } from '../snapshots/builder';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { featureDisabledBody } from '../feature-flags/gate';
import {
  buildCompiledPiRuntimeArtifact,
  CompiledPiRuntimeSourceMovedError,
} from './compiled-pi-runtime-artifact';
import {
  COMPILED_PI_RUNTIME_CONTENT_TYPE,
  COMPILED_PI_RUNTIME_FORMAT,
} from './compiled-pi-runtime';
import { prebuildDefaultBranchPiRuntime } from './compiled-prebuild';
import {
  COMPILED_CHECKOUT_CONTENT_TYPE,
  COMPILED_CHECKOUT_FORMAT,
  CompiledCheckoutSourceMovedError,
  CompiledCheckoutTooLargeError,
  buildCompiledCheckoutArtifact,
} from './compiled-checkout';
import {
  CompiledRuntimeSourceMovedError,
  buildCompiledRuntimeArtifact,
} from './compiled-runtime-artifact';
import {
  COMPILED_RUNTIME_CONTENT_TYPE,
  COMPILED_RUNTIME_FORMAT,
} from './compiled-runtime';
import { prebuildDefaultBranchArtifacts } from './compiled-prebuild';
import { config } from '../config';

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

function validProjectIdOrResponse(c: any, raw: string): string | Response {
  const projectId = normalizeProjectId(raw);
  if (!isValidGitProxyProjectId(raw)) {
    return c.text('invalid project identifier', 400);
  }
  return projectId;
}

async function authorize(c: any, projectId: string, scope: GitScope): Promise<GitProxyAuth> {
  const token = extractToken(c.req.header('authorization'));
  if (!token) return { ok: false, status: 401, message: 'authentication required' };
  // Pass the request context so IP-allowlist / require-MFA policy conditions
  // evaluate on the per-project capability path the same way they do on every
  // other project route.
  return authorizeGitProxy(token, projectId, scope, deriveRequestContext(c));
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
  // Idempotent ref discovery (GET /info/refs) → buffer + bounded retry, so a
  // transient upstream socket-close is caught here instead of escaping Bun's
  // fetch streamer to the global uncaught handler (Better Stack `df7a31d4…`).
  // Pack streams (POST upload/receive-pack) stay streamed: large / non-idempotent.
  const isIdempotentGet = method === 'GET' || method === 'HEAD';
  let res: Response;
  try {
    if (isIdempotentGet) {
      res = await fetchUpstreamBuffered(target, {
        method,
        headers,
        redirect: 'manual',
        // @ts-ignore — Bun extension: don't decompress the git smart-HTTP body.
        decompress: false,
      });
    } else {
      res = await fetch(target, {
        method,
        headers,
        body: c.req.raw.body,
        redirect: 'manual',
        // @ts-ignore — Bun extensions: stream the request body, don't decompress.
        duplex: 'half',
        decompress: false,
      });
    }
  } catch (err) {
    console.warn(`[git-proxy] upstream fetch failed for ${projectId}:`, err);
    return c.text('git upstream unreachable', 502);
  }

  const respHeaders = new Headers();
  res.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  // Build-on-push warm prebake: a successful push (git-receive-pack) to the
  // managed git may have advanced the project's default-branch tip. Kick a
  // fire-and-forget per-project warm bake so the FIRST session on the new commit
  // boots warm instead of cold ("starting agent…"). Never blocks or fails the
  // push; kickProjectWarmPrebake resolves the current tip and is idempotent, so it
  // no-ops unless the default-branch tip actually moved. The session-start
  // on-demand trigger stays the fallback for projects that never push.
  //
  // Pass the per-project provider PIN so the prebake warms the provider(s) a
  // session on this project will actually use (pinned provider ⇒ that one; no
  // pin ⇒ every enabled provider) — full parity, not just the default provider.
  if (suffix === '/git-receive-pack' && res.status >= 200 && res.status < 300) {
    void (async () => {
      try {
        const gitProject = await loadGitProject({ row: auth.project });
        const projectPin =
          typeof (auth.project.metadata as Record<string, unknown> | null)?.default_sandbox_provider === 'string'
            ? ((auth.project.metadata as Record<string, unknown>).default_sandbox_provider as string)
            : null;
        // The pi_worker flag also lifts the compiled-boot env gate for THIS
        // project's opencode artifacts: dev runs with KORTIX_COMPILED_BOOT_MODE
        // unset ('off'), and the harness/worker experiment needs both engines'
        // artifacts warm per project without touching the environment. The env
        // mode stays the platform-wide switch; the flag is the per-project one.
        const piWorkerEnabled = resolveFeatureFlag(auth.project.metadata, 'pi_worker');
        const [compiledResult, piResult] = await Promise.allSettled([
          config.KORTIX_COMPILED_BOOT_MODE !== 'off' || piWorkerEnabled
            ? prebuildDefaultBranchArtifacts(
                gitProject,
                `${new URL(c.req.url).origin}/v1/git/${projectId}.git`,
              )
            : Promise.resolve(null),
          // Compile-on-push for the pi worker runtime (harness/worker split
          // experiment). Per-project opt-in; the metadata is already loaded by
          // this push's auth, so the flag check costs nothing. Fire-and-forget
          // like everything else in this block — the on-demand build inside
          // GET /compiled-pi-runtime stays the correctness path for pushes
          // that bypass this proxy (e.g. straight to a user's own GitHub).
          piWorkerEnabled ? prebuildDefaultBranchPiRuntime(gitProject) : Promise.resolve(null),
          kickProjectWarmPrebake(gitProject, {
            accountId: auth.project.accountId,
            projectPin,
          }),
        ]);
        if (compiledResult.status === 'rejected') {
          console.warn(
            `[git-proxy] compiled artifact prebuild skipped for ${projectId}:`,
            compiledResult.reason instanceof Error
              ? compiledResult.reason.message
              : compiledResult.reason,
          );
        }
        if (piResult.status === 'rejected') {
          console.warn(
            `[git-proxy] compiled pi runtime prebuild skipped for ${projectId}:`,
            piResult.reason instanceof Error ? piResult.reason.message : piResult.reason,
          );
        }
      } catch (err) {
        console.warn(
          `[git-proxy] warm prebake-on-push skipped for ${projectId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }

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
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
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
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
    return forward(c, projectId, 'read', '/git-upload-pack');
  },
);

gitProxyApp.openapi(
  createRoute({
    method: 'get',
    path: '/{project}/compiled-checkout',
    tags: ['git'],
    summary: 'Download an exact compiled checkout for sandbox cold boot',
    request: {
      params: projectParam,
      query: z.object({
        ref: z.string().min(1),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
      }),
    },
    responses: {
      200: {
        description: 'Gzip archive containing the exact shallow checkout and Git state',
        content: { [COMPILED_CHECKOUT_CONTENT_TYPE]: { schema: z.any() } },
      },
      400: { description: 'Invalid project id, ref, or source SHA' },
      401: gitResponses[401],
      403: gitResponses[403],
      404: gitResponses[404],
      409: { description: 'The requested ref no longer points at the requested source SHA' },
      413: { description: 'The compiled checkout exceeds the configured artifact limit' },
      503: { description: 'The compiled checkout could not be generated' },
    },
  }),
  async (c) => {
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
    const auth = await authorize(c, projectId, 'read');
    if (!auth.ok) {
      if (auth.status === 401) return unauthorized(c, auth.message);
      return c.text(auth.message, auth.status === 404 ? 404 : 403);
    }
    const { ref, sha } = c.req.valid('query');
    const runtimeRepoUrl = `${new URL(c.req.url).origin}/v1/git/${projectId}.git`;
    try {
      const project = await loadGitProject({ row: auth.project });
      const artifact = await buildCompiledCheckoutArtifact(
        project,
        ref,
        sha,
        runtimeRepoUrl,
      );
      return new Response(Bun.file(artifact.path), {
        status: 200,
        headers: {
          'cache-control': 'private, max-age=31536000, immutable',
          'content-length': String(artifact.size),
          'content-type': COMPILED_CHECKOUT_CONTENT_TYPE,
          etag: `"sha256-${artifact.sha256}"`,
          'x-kortix-artifact-format': COMPILED_CHECKOUT_FORMAT,
          'x-kortix-artifact-sha256': artifact.sha256,
          'x-kortix-artifact-source-sha': artifact.sourceSha,
          'x-kortix-artifact-cache': artifact.cacheHit ? 'hit' : 'miss',
        },
      });
    } catch (error) {
      if (error instanceof CompiledCheckoutSourceMovedError) return c.text(error.message, 409);
      if (error instanceof CompiledCheckoutTooLargeError) return c.text(error.message, 413);
      console.warn('[git-proxy] compiled checkout unavailable', {
        projectId,
        ref,
        sha,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.text('compiled checkout unavailable', 503);
    }
  },
);

gitProxyApp.openapi(
  createRoute({
    method: 'get',
    path: '/{project}/compiled-runtime',
    tags: ['git'],
    summary: 'Download an exact compiled OpenCode server for sandbox cold boot',
    request: {
      params: projectParam,
      query: z.object({
        ref: z.string().min(1),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
      }),
    },
    responses: {
      200: {
        description: 'Executable server.mjs containing immutable project agent configuration',
        content: { [COMPILED_RUNTIME_CONTENT_TYPE]: { schema: z.any() } },
      },
      400: { description: 'Invalid project id, ref, or source SHA' },
      401: gitResponses[401],
      403: gitResponses[403],
      404: gitResponses[404],
      409: { description: 'The requested ref no longer points at the requested source SHA' },
      503: { description: 'The compiled runtime could not be generated' },
    },
  }),
  async (c) => {
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
    const auth = await authorize(c, projectId, 'read');
    if (!auth.ok) {
      if (auth.status === 401) return unauthorized(c, auth.message);
      return c.text(auth.message, auth.status === 404 ? 404 : 403);
    }
    const { ref, sha } = c.req.valid('query');
    try {
      const project = await loadGitProject({ row: auth.project });
      const artifact = await buildCompiledRuntimeArtifact(project, ref, sha);
      return new Response(Bun.file(artifact.path), {
        status: 200,
        headers: {
          'cache-control': 'private, max-age=31536000, immutable',
          'content-length': String(artifact.size),
          'content-type': COMPILED_RUNTIME_CONTENT_TYPE,
          etag: `"sha256-${artifact.sha256}"`,
          'x-kortix-artifact-format': COMPILED_RUNTIME_FORMAT,
          'x-kortix-artifact-sha256': artifact.sha256,
          'x-kortix-artifact-source-sha': artifact.sourceSha,
          'x-kortix-artifact-cache': artifact.cacheHit ? 'hit' : 'miss',
        },
      });
    } catch (error) {
      if (error instanceof CompiledRuntimeSourceMovedError) return c.text(error.message, 409);
      console.warn('[git-proxy] compiled runtime unavailable', {
        projectId,
        ref,
        sha,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.text('compiled runtime unavailable', 503);
    }
  },
);

gitProxyApp.openapi(
  createRoute({
    method: 'get',
    path: '/{project}/compiled-pi-runtime',
    tags: ['git'],
    summary: 'Download an exact compiled pi worker runtime for the harness/worker split',
    request: {
      params: projectParam,
      query: z.object({
        ref: z.string().min(1),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
      }),
    },
    responses: {
      200: {
        description:
          'Executable worker .mjs carrying the agent config compiled from kortix.yaml at the exact source SHA',
        content: { [COMPILED_PI_RUNTIME_CONTENT_TYPE]: { schema: z.any() } },
      },
      400: { description: 'Invalid project id, ref, or source SHA' },
      401: gitResponses[401],
      403: { description: 'Forbidden, or the pi_worker feature flag is off for this project' },
      404: gitResponses[404],
      409: { description: 'The requested ref no longer points at the requested source SHA' },
      503: { description: 'The compiled pi runtime could not be generated' },
    },
  }),
  async (c) => {
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
    const auth = await authorize(c, projectId, 'read');
    if (!auth.ok) {
      if (auth.status === 401) return unauthorized(c, auth.message);
      return c.text(auth.message, auth.status === 404 ? 404 : 403);
    }
    // Per-project opt-in: the artifact must not exist for a project that never
    // asked for it, and the on-demand build below is exactly as gated as the
    // push-time prebuild.
    if (!resolveFeatureFlag(auth.project.metadata, 'pi_worker')) {
      return c.json(featureDisabledBody('pi_worker'), 403);
    }
    const { ref, sha } = c.req.valid('query');
    try {
      const project = await loadGitProject({ row: auth.project });
      const artifact = await buildCompiledPiRuntimeArtifact(project, ref, sha);
      return new Response(Bun.file(artifact.path), {
        status: 200,
        headers: {
          'cache-control': 'private, max-age=31536000, immutable',
          'content-length': String(artifact.size),
          'content-type': COMPILED_PI_RUNTIME_CONTENT_TYPE,
          etag: `"sha256-${artifact.sha256}"`,
          'x-kortix-artifact-format': COMPILED_PI_RUNTIME_FORMAT,
          'x-kortix-artifact-sha256': artifact.sha256,
          'x-kortix-artifact-source-sha': artifact.sourceSha,
          'x-kortix-artifact-cache': artifact.cacheHit ? 'hit' : 'miss',
        },
      });
    } catch (error) {
      if (error instanceof CompiledPiRuntimeSourceMovedError) return c.text(error.message, 409);
      console.warn('[git-proxy] compiled pi runtime unavailable', {
        projectId,
        ref,
        sha,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.text('compiled pi runtime unavailable', 503);
    }
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
    const projectId = validProjectIdOrResponse(c, c.req.param('project'));
    if (projectId instanceof Response) return projectId;
    return forward(c, projectId, 'write', '/git-receive-pack');
  },
);
