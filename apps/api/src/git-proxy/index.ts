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
 *
 * Service-level scope is NOT the whole story for pushes. On
 * `git-receive-pack`, an AGENT principal (sandbox token / session PAT) also has
 * its command list parsed off the head of the body, and a push touching the
 * project's default branch is refused with a git-native rejection — the
 * server-side enforcement of R-9.6 ("work reaches the default branch only
 * through a change request"). Human principals are never parsed, so every
 * human flow (`git push`, `kortix ship` from a laptop) is byte-identical to
 * before. See `receive-pack.ts` and `principal.ts`.
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
import { getProjectGitConnection, loadGitProject } from '../projects/lib/git';
import { kickProjectWarmPrebake } from '../snapshots/builder';
import { classifyGitPrincipal, protectedRefsFor } from './principal';
import {
  buildProtectedRefRejection,
  decideReceivePack,
  drainRequestBody,
  parseReceivePackCommands,
  peekReceivePackHead,
  replayReceivePackBody,
  type ReceivePackDecision,
} from './receive-pack';
import { config } from '../config';
import { recordAuditEvent } from '../shared/audit';

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

/** One line per receive-pack decision, in ALL modes. This is how the first hour
 *  of prod data answers "did we break session pushes" — which matters more than
 *  the observe canary. Distinct reason codes keep "we broke pushes"
 *  (deny:unparseable) and "we blocked an attack" (deny:protected-ref) from ever
 *  being the same line on a dashboard. */
function logReceivePackDecision(input: {
  mode: string;
  outcome: 'allow' | 'deny' | 'observe-deny';
  projectId: string;
  principalKind: string;
  principalClass: string;
  reason: string;
  refCount?: number;
  matchedRefs?: string[];
}) {
  const { outcome, projectId, principalKind, principalClass, reason } = input;
  console.log(
    `[git-proxy] receive-pack ${outcome} project=${projectId} principal=${principalKind}/${principalClass} ` +
      `reason=${reason} refs=${input.refCount ?? 0} matched=${(input.matchedRefs ?? []).join(',') || '-'} ` +
      `mode=${input.mode}`,
  );
}

/**
 * R-9.6 enforcement: an agent principal may not push a protected ref.
 *
 * Returns `{ response }` to refuse the push outright (the caller MUST return it
 * immediately — see the prebake note in `forward`), or `{ body }` with a
 * re-emitted request stream when the push is allowed and we consumed part of
 * the body to inspect it. `{}` means "we did not touch the body, forward it
 * exactly as before" — the path every human request takes.
 */
async function guardReceivePack(
  c: any,
  auth: Extract<GitProxyAuth, { ok: true }>,
  projectId: string,
): Promise<{ response?: Response; body?: ReadableStream<Uint8Array> | null }> {
  const mode = config.KORTIX_GIT_PROXY_DEFAULT_BRANCH_PROTECTION;
  if (mode === 'off') return {};

  const principalClass = classifyGitPrincipal(auth.principal);
  if (principalClass !== 'agent') {
    // A human push is NEVER parsed: zero new failure surface for `git push`
    // from a laptop or `kortix ship`, and the reason fail-closed below is
    // affordable at all.
    logReceivePackDecision({
      mode,
      outcome: 'allow',
      projectId,
      principalKind: auth.principal.kind,
      principalClass,
      reason: 'not-agent',
    });
    return {};
  }

  // The protected set is the UNION of both default_branch columns: PATCH
  // /v1/projects/:id updates only `projects.default_branch` and leaves the
  // connection row stale, so checking one column leaves the other as a bypass.
  // A failed connection read degrades to the `projects` column rather than
  // failing the push — the same query runs again in resolveProjectUpstream a
  // few lines later, which 502s if the DB is genuinely unreachable.
  let connectionDefaultBranch: string | null = null;
  try {
    connectionDefaultBranch = (await getProjectGitConnection(projectId))?.defaultBranch ?? null;
  } catch (err) {
    console.warn(`[git-proxy] git connection lookup failed for ${projectId}:`, err);
  }
  const protectedRefs = protectedRefsFor({
    projectDefaultBranch: auth.project.defaultBranch,
    connectionDefaultBranch,
  });

  const rawBody = c.req.raw.body as ReadableStream<Uint8Array> | null;
  const encoding = (c.req.header('content-encoding') || '').trim().toLowerCase();

  let decision: ReceivePackDecision;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let replay: ReadableStream<Uint8Array> | null = null;
  // How many refs the push actually carried — logged on ALLOW too, so the
  // dashboard can show agent pushes flowing rather than only failures.
  let parsedRefCount = 0;

  if (encoding && encoding !== 'identity') {
    decision = decideReceivePack({
      principalClass,
      protectedRefs,
      parsed: { ok: false, reason: 'content-encoding' },
    });
    // Deliberately do NOT take the reader here. `observe` mode must forward the
    // request untouched, and once a reader is acquired the original stream is
    // locked and can no longer be handed to fetch — we would silently forward
    // an EMPTY push. The reader is taken later, only on the enforce+drain path.
  } else if (!rawBody) {
    decision = decideReceivePack({
      principalClass,
      protectedRefs,
      parsed: { ok: false, reason: 'no-body' },
    });
  } else {
    reader = rawBody.getReader();
    const peek = await peekReceivePackHead(reader);
    if (peek.parsed.ok) parsedRefCount = peek.parsed.commands.length;
    decision = decideReceivePack({ principalClass, protectedRefs, parsed: peek.parsed });
    replay = replayReceivePackBody({ head: peek.head, reader, upstreamDone: peek.upstreamDone });
  }

  if (decision.action === 'allow') {
    logReceivePackDecision({
      mode,
      outcome: 'allow',
      projectId,
      principalKind: auth.principal.kind,
      principalClass,
      reason: decision.reason,
      refCount: parsedRefCount,
    });
    // `replay` is null only when we never consumed the body; forward the
    // original stream in that case rather than a null body.
    return replay ? { body: replay } : {};
  }

  const matchedRefs = decision.reason === 'protected-ref' ? decision.matchedRefs : [];
  const denyCode = decision.reason === 'protected-ref'
    ? 'protected-ref'
    : `unparseable:${decision.detail}`;

  logReceivePackDecision({
    mode,
    outcome: mode === 'observe' ? 'observe-deny' : 'deny',
    projectId,
    principalKind: auth.principal.kind,
    principalClass,
    reason: denyCode,
    refCount: parsedRefCount,
    matchedRefs,
  });

  // Audit every denial (and every would-be denial in observe mode). Never
  // blocks or fails the request it describes.
  void recordAuditEvent({
    accountId: auth.project.accountId,
    actorUserId: 'userId' in auth.principal ? auth.principal.userId : undefined,
    action: mode === 'observe'
      ? 'git_proxy.push.default_branch_observed'
      : 'git_proxy.push.default_branch_denied',
    resourceType: 'project',
    resourceId: projectId,
    metadata: {
      principal_kind: auth.principal.kind,
      deny_reason: denyCode,
      protected_refs: protectedRefs,
      matched_refs: matchedRefs,
      mode,
    },
  }).catch((err) => console.error('[git-proxy] deny audit write failed', err));

  if (mode === 'observe') {
    // Canary: the decision is recorded, the push is forwarded UNALTERED. If we
    // never consumed the body (`replay === null`), hand back the original
    // stream — returning a null body here would forward an empty push and turn
    // a read-only canary into an outage.
    return replay ? { body: replay } : {};
  }

  // git will not SHOW our rejection unless we consume the request first —
  // otherwise it prints "the remote end hung up unexpectedly" and the caller
  // never learns to open a change request instead.
  if (!reader && rawBody) reader = rawBody.getReader();
  if (reader) await drainRequestBody(reader);

  if (decision.reason === 'protected-ref') {
    // HTTP 200 carrying a report-status document. A 403 body is invisible to
    // git; this renders as `! [remote rejected]` and still exits non-zero.
    return {
      response: new Response(buildProtectedRefRejection(decision), {
        status: 200,
        headers: {
          'content-type': 'application/x-git-receive-pack-result',
          'cache-control': 'no-cache',
          'x-kortix-deny-reason': denyCode,
        },
      }),
    };
  }

  // Unparseable: we have no ref names, so no report-status can be built. Fall
  // back to a 403 whose body git will not display — accepted, because this
  // should ~never happen, and the header + audit row carry the detail.
  return {
    response: new Response(
      'Kortix: this push was refused by the git proxy — the receive-pack command list could not be read.\n',
      {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-kortix-deny-reason': denyCode,
        },
      },
    ),
  };
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

  // Ref-level protection runs BEFORE upstream resolution so we never mint a
  // host credential for a push we are about to refuse. `/info/refs` and
  // `/git-upload-pack` never reach this — clone, fetch and discovery have no
  // new failure mode at all.
  let guardedBody: ReadableStream<Uint8Array> | null | undefined;
  if (suffix === '/git-receive-pack') {
    const guard = await guardReceivePack(c, auth, projectId);
    // EARLY RETURN, deliberately: a denial is an HTTP 200, and falling through
    // to the shared response path would kick a per-project warm prebake for
    // every refused push.
    if (guard.response) return guard.response;
    guardedBody = guard.body;
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
        // `guardedBody` is the re-emitted head+rest stream when we inspected a
        // push; `undefined` (every human request, every non-push) forwards the
        // original stream byte-identically. Either way the packfile is still
        // STREAMED — buffering a push would OOM the API on a large repo.
        body: guardedBody !== undefined ? guardedBody : c.req.raw.body,
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
        await kickProjectWarmPrebake(gitProject, { accountId: auth.project.accountId, projectPin });
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
