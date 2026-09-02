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
import type { GitScope, UpstreamGit } from '../projects/git-backends';
import type { ProjectRow } from '../projects/lib/serializers';
import { deriveRequestContext } from '../iam/cache';
import {
  MAX_COMMAND_SECTION_BYTES,
  encodeReportStatus,
  parseReceivePackCommands,
  wantsSideband,
} from './receive-pack';
import { evaluateRefUpdates, principalLabel } from './ref-policy';
import { denialsAfterScopes } from './ref-scopes';
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
import { refreshMirror, runGit } from '../projects/git/mirror';
import { writeScaffoldDeltaBundle } from '../projects/git/commits';
import { resolveFastBootGitHintWithCache } from '../projects/lib/fast-boot-git-hint';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * One clone is 2–3 git requests inside a few seconds (`info/refs`, then
 * `upload-pack`, sometimes a second fetch). Each used to re-resolve the
 * project's git connection + host credential from the DB — measured 2026-08-27
 * on dev as the bulk of a ~1 s per-request tax (API in us-west-2, DB in
 * us-east-2). The upstream is stable for far longer than a clone, so memoize it
 * briefly per (project, scope). Positive results only; the credential inside is
 * either the static managed PAT or a ≥1 h installation token.
 */
const UPSTREAM_MEMO_TTL_MS = 30_000;
const upstreamMemo = new Map<string, { value: UpstreamGit; expiresAt: number }>();
async function resolveProjectUpstreamMemo(
  project: ProjectRow,
  scope: GitScope,
): Promise<UpstreamGit | null> {
  const key = `${project.projectId}|${scope}`;
  const now = Date.now();
  const hit = upstreamMemo.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await resolveProjectUpstream(project, scope);
  if (value?.url) upstreamMemo.set(key, { value, expiresAt: now + UPSTREAM_MEMO_TTL_MS });
  if (upstreamMemo.size > 5_000) {
    for (const [k, v] of upstreamMemo) if (v.expiresAt <= now) upstreamMemo.delete(k);
  }
  return value;
}
export function __resetGitProxyMemosForTests(): void {
  upstreamMemo.clear();
}

async function forward(c: any, projectId: string, scope: GitScope, suffix: string): Promise<Response> {
  const auth = await authorize(c, projectId, scope);
  if (!auth.ok) {
    if (auth.status === 401) return unauthorized(c, auth.message);
    return c.text(auth.message, auth.status);
  }
  return forwardAuthorized(c, auth, scope, suffix, c.req.raw.body);
}

/**
 * Stream an ALREADY-AUTHORIZED git request to the upstream.
 *
 * Split out of `forward` so the push route can sit between authorization and
 * transmission: it reads the ref commands off the head of the body, applies the
 * ref policy, and either refuses (without opening an upstream connection at
 * all) or hands the reconstructed body back here untouched.
 */
async function forwardAuthorized(
  c: any,
  auth: Extract<GitProxyAuth, { ok: true }>,
  scope: GitScope,
  suffix: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  const projectId = auth.project.projectId;
  const upstream = await resolveProjectUpstreamMemo(auth.project, scope);
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
        body,
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

  // Build-on-push warming: a successful push (git-receive-pack) to the managed
  // git may have advanced the project's default-branch tip. Kick the
  // fire-and-forget warms that make the FIRST session on the new commit fast
  // (the fast-boot git hint below, and the compiled/pi-worker artifact
  // prebuilds) instead of cold ("starting agent…"). None of them blocks or
  // fails the push, and each is idempotent, so a push that did not move the tip
  // costs nothing. Session-start remains the on-demand fallback for projects
  // that never push.
  //
  // The per-project provider PIN is read here so a prebuild targets the
  // provider(s) a session on this project will actually use (pinned provider =>
  // that one; no pin => every enabled provider).
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
        // Warm the fresh-session git hint (base tip + scaffold delta + OpenCode
        // config dir) right after the push that moved the tip, so the next
        // session create finds it cached instead of losing the 2 s create-time
        // race on a cold mirror (measured on dev 2026-08-27: a 200 KB delta's
        // first session fell back to a 6 s proxied fetch; the second, with the
        // cached hint, materialized in 1.7 s via the remote bundle).
        if (config.KORTIX_FAST_GIT_BOOT_ENABLED) {
          void resolveFastBootGitHintWithCache(
            gitProject,
            gitProject.defaultBranch,
            auth.project.metadata,
          ).catch((err) => {
            console.warn(
              `[git-proxy] fast-boot hint warm skipped for ${projectId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
        // MANIFEST TRIPWIRE. A project always has a manifest
        // (../projects/managed-repo-seed.ts). Provisioning now guarantees one
        // at birth and `kortix ship` refuses to push without one, but a plain
        // `git push` straight at this proxy can still land a default branch
        // with no kortix.yaml — which produces a project with no declared
        // agents, no skills, and manifest detection falling back to v1
        // `kortix.toml`. That used to be discovered as an unexplained
        // session-start failure, long after the push.
        //
        // This cannot REJECT the push: the proxy streams the pack straight to
        // the upstream and only runs here on a 2xx, so the commit has already
        // landed on GitHub. Blocking it pre-commit means staging the (thin)
        // pack through the mirror first — tracked separately. Until then, name
        // it at the moment it happens instead of letting it surface as a
        // mystery two steps downstream.
        //
        // The mirror is already refreshed by this block, so this is one
        // pathspec-scoped ls-tree.
        void (async () => {
          try {
            const repoPath = await refreshMirror(gitProject);
            const listed = await runGit(
              ['ls-tree', gitProject.defaultBranch, '--', 'kortix.yaml', 'kortix.yml', 'kortix.toml'],
              repoPath,
            );
            if (!listed.stdout.trim()) {
              console.error(
                `[git-proxy] MANIFEST MISSING after push to ${projectId}: ` +
                  `${gitProject.defaultBranch} has no kortix.yaml. This project cannot ` +
                  `declare agents or skills and session start will fail.`,
              );
            }
          } catch (err) {
            console.warn(
              `[git-proxy] manifest tripwire skipped for ${projectId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        })();

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

// ── ref policy on push ────────────────────────────────────────────────────
/**
 * Read the ref commands off the head of a receive-pack body and decide whether
 * the push may proceed.
 *
 * Returns a `Response` when the push is refused — a real git report-status, so
 * the user sees `! [remote rejected] <ref> (<reason>)` and a non-zero exit
 * rather than a transport error. Otherwise returns the body to forward: the
 * bytes already consumed, followed by the untouched remainder of the stream.
 * Nothing is uploaded to the upstream on a refusal.
 */
async function gateReceivePack(
  c: any,
  auth: Extract<GitProxyAuth, { ok: true }>,
): Promise<Response | { body: ReadableStream<Uint8Array> }> {
  // git never content-encodes a receive-pack body (it gzips upload-pack
  // requests only, verified against git 2.39.1). If one ever arrives encoded we
  // cannot read the commands, so we refuse instead of forwarding unexamined.
  const encoding = c.req.header('content-encoding');
  if (encoding) {
    return c.text(`git proxy cannot inspect a ${encoding}-encoded push`, 400);
  }
  const stream: ReadableStream<Uint8Array> | null = c.req.raw.body;
  if (!stream) return c.text('empty receive-pack request', 400);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let parsed = parseReceivePackCommands(new Uint8Array(0));
  while (parsed.status === 'need-more') {
    if (buffered > MAX_COMMAND_SECTION_BYTES) {
      reader.cancel().catch(() => {});
      return c.text('receive-pack command section is implausibly large', 400);
    }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    buffered += value.length;
    parsed = parseReceivePackCommands(concatChunks(chunks, buffered));
  }
  if (parsed.status !== 'ok') {
    reader.cancel().catch(() => {});
    const reason = parsed.status === 'invalid' ? parsed.reason : 'truncated receive-pack request';
    return c.text(reason, 400);
  }

  // Pure policy first: it needs no I/O and answers every ordinary push. Only a
  // denial is worth an authorization check, so a session pushing its own branch
  // and a person pushing anything both reach the upstream without one.
  const denials = denialsAfterScopes(
    c,
    auth.principal,
    evaluateRefUpdates(auth.principal, { defaultBranch: auth.project.defaultBranch }, parsed.updates),
  );
  if (denials.length > 0) {
    // Refuse before a single pack byte is uploaded. The client is mid-send;
    // git handles an early response and prints our per-ref reasons, so there is
    // no need to drain the pack we are rejecting (verified against git 2.39.1).
    reader.cancel().catch(() => {});
    const denied = new Map(denials.map((d) => [d.ref, d.reason]));
    console.warn('[git-proxy] push refused', {
      projectId: auth.project.projectId,
      principal: principalLabel(auth.principal),
      refs: denials.map((d) => d.ref),
    });
    const report = encodeReportStatus(
      parsed.updates.map((u) => ({ ref: u.ref, reason: denied.get(u.ref) })),
      { sideband: wantsSideband(parsed.capabilities) },
    );
    return new Response(report as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-result' },
    });
  }

  // Allowed: replay what we read, then hand the rest of the stream straight
  // through. The pack itself is never buffered.
  const prefix = concatChunks(chunks, buffered);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (prefix.length > 0) controller.enqueue(prefix);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    }),
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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


// ── fast-boot delta bundle ────────────────────────────────────────────────
// The session env carries the delta `tip ^root` inline when it fits 24 KiB.
// Above that the daemon fetches it here: ONE authenticated GET served from the
// API's mirror — no GitHub hop, no pack negotiation, no proxied `git fetch`.
function fastBootBundleCacheRoot(): string {
  return process.env.KORTIX_FAST_BOOT_BUNDLE_CACHE_DIR || '/tmp/kortix/fast-boot-bundles';
}
/**
 * Total on-disk budget for cached bundles (default 512 MiB). Every distinct
 * (project, tip, parent) is one file of up to 64 MiB, and any read-authorized
 * caller can name ancestor pairs freely — so the cache is bounded and evicts
 * least-recently-used entries past the budget instead of growing with the
 * request stream.
 */
function fastBootBundleCacheMaxBytes(): number {
  const configured = Number(process.env.KORTIX_FAST_BOOT_BUNDLE_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 512 * 1024 * 1024;
}
const FAST_BOOT_BUNDLE_CONTENT_TYPE = 'application/x-git-bundle';
const fastBootBundleBuilds = new Map<string, Promise<{ path: string; size: number }>>();
let fastBootBundleEviction: Promise<void> | null = null;
/** LRU eviction by mtime until the cache fits the budget; serialized, best-effort. */
function enforceFastBootBundleBudget(root: string, keep: string): Promise<void> {
  if (fastBootBundleEviction) return fastBootBundleEviction;
  fastBootBundleEviction = (async () => {
    try {
      const entries = await readdir(root);
      const files: { path: string; size: number; mtimeMs: number }[] = [];
      for (const name of entries) {
        if (!name.endsWith('.bundle')) continue;
        const path = join(root, name);
        try {
          const st = await stat(path);
          files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }
      let total = files.reduce((sum, f) => sum + f.size, 0);
      const budget = fastBootBundleCacheMaxBytes();
      if (total <= budget) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files) {
        if (total <= budget) break;
        if (f.path === keep) continue;
        await rm(f.path, { force: true }).catch(() => {});
        total -= f.size;
      }
    } catch (err) {
      console.warn('[git-proxy] fast-boot bundle cache eviction failed', err instanceof Error ? err.message : err);
    }
  })().finally(() => {
    fastBootBundleEviction = null;
  });
  return fastBootBundleEviction;
}
async function buildFastBootBundle(
  project: Awaited<ReturnType<typeof loadGitProject>>,
  ref: string,
  tip: string,
  parent: string,
): Promise<{ path: string; size: number; cacheHit: boolean }> {
  const root = fastBootBundleCacheRoot();
  await mkdir(root, { recursive: true });
  const key = createHash('sha256').update(`${project.projectId}\0${tip}\0${parent}`).digest('hex');
  const path = join(root, `${key}.bundle`);
  try {
    const existing = await stat(path);
    if (existing.size > 0) {
      // Touch on hit so eviction is least-RECENTLY-used, not oldest-built.
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return { path, size: existing.size, cacheHit: true };
    }
  } catch {}
  let build = fastBootBundleBuilds.get(key);
  if (!build) {
    build = (async () => {
      let mirror = await refreshMirror(project);
      const has = await runGit(['cat-file', '-e', `${tip}^{commit}`], mirror, false).then(
        () => true,
        () => false,
      );
      if (!has) mirror = await refreshMirror(project, true);
      const staged = `${path}.${process.pid}.tmp`;
      await rm(staged, { force: true });
      const size = await writeScaffoldDeltaBundle(mirror, ref, tip, parent, staged);
      await rename(staged, path);
      void enforceFastBootBundleBudget(root, path);
      return { path, size };
    })().finally(() => fastBootBundleBuilds.delete(key));
    fastBootBundleBuilds.set(key, build);
  }
  const built = await build;
  return { ...built, cacheHit: false };
}

gitProxyApp.openapi(
  createRoute({
    method: 'get',
    path: '/{project}/fast-boot-bundle',
    tags: ['git'],
    summary: 'Download the scaffold→tip git bundle a fresh sandbox applies at boot',
    request: {
      params: projectParam,
      query: z.object({
        ref: z.string().min(1),
        tip: z.string().regex(/^[0-9a-f]{40}$/),
        parent: z.string().regex(/^[0-9a-f]{40}$/),
      }),
    },
    responses: {
      200: {
        description: 'git bundle containing every commit in parent..tip',
        content: { [FAST_BOOT_BUNDLE_CONTENT_TYPE]: { schema: z.any() } },
      },
      400: { description: 'Invalid project id, ref, or SHA' },
      401: gitResponses[401],
      403: gitResponses[403],
      404: gitResponses[404],
      409: { description: 'The ref no longer points at `tip`, or `parent` is not its ancestor' },
      413: { description: 'The bundle exceeds the fast-boot size limit' },
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
    const { ref, tip, parent } = c.req.valid('query');
    try {
      const project = await loadGitProject({ row: auth.project });
      const bundle = await buildFastBootBundle(project, ref, tip, parent);
      return new Response(Bun.file(bundle.path), {
        status: 200,
        headers: {
          'cache-control': 'private, max-age=31536000, immutable',
          'content-length': String(bundle.size),
          'content-type': FAST_BOOT_BUNDLE_CONTENT_TYPE,
          'x-kortix-artifact-cache': bundle.cacheHit ? 'hit' : 'miss',
          'x-kortix-artifact-source-sha': tip,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/exceeds/.test(message)) return c.text(message, 413);
      if (/is at |not an ancestor/.test(message)) return c.text(message, 409);
      console.warn('[git-proxy] fast-boot bundle unavailable', { projectId, ref, tip, parent, error: message });
      return c.text('fast-boot bundle unavailable', 503);
    }
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
    const auth = await authorize(c, projectId, 'write');
    if (!auth.ok) {
      if (auth.status === 401) return unauthorized(c, auth.message);
      return c.text(auth.message, auth.status as 403 | 404);
    }
    // Ref policy runs HERE, between authorization and transmission — the only
    // point where both the principal and the refs it wants to move are known.
    const gated = await gateReceivePack(c, auth);
    if (gated instanceof Response) return gated;
    return forwardAuthorized(c, auth, 'write', '/git-receive-pack', gated.body);
  },
);
