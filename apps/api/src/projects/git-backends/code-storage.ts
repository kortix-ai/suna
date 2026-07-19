/**
 * code.storage (Pierre) managed git backend — a headless git-hosting layer
 * reached entirely over plain HTTPS (management API + git smart-HTTP), no
 * local git binary required server-side (unlike the GitHub backend's
 * `seedRepoViaGitPush`, which shells out to `git`).
 *
 * Auth model (see https://code.storage/docs/getting-started/authentication):
 * every request — management API AND git push/pull — carries a JWT you sign
 * yourself with your org's PKCS8 private key (ES256 or RS256, auto-detected
 * from the key). Claims: `iss` (org), `sub` (agent identity, for logging),
 * `repo` (optional — a single repo path; OMIT for org-wide tokens), `scopes`,
 * `iat`, `exp`. There is no key-exchange or OAuth dance — a compromised
 * private key is a full compromise, so it lives ONLY in
 * `CODE_STORAGE_PRIVATE_KEY` and is never logged, returned to a caller, or
 * embedded anywhere except the one signature it produces.
 *
 * `mintCodeStorageJwt` is the SINGLE place that signs a token — every
 * operation below (createRepo, deleteRepo, seedFiles, buildUpstream) goes
 * through it with a scope-appropriate, short-lived claim set. It's
 * deliberately synchronous (Node's `crypto.createSign` supports fully sync
 * EC/RSA signing) rather than using the async `jose` SignJWT path used
 * elsewhere in this repo (e.g. channels/teams/jwt.ts's verify side) — sync
 * matters because `buildUpstream` is a SYNC method on `GitHostBackend`
 * (types.ts docstring: token resolution stays with the project layer for
 * OTHER backends, but code.storage mints its own on demand, and it can't
 * `await` inside a sync call). Verified against `jose`'s verifier (round-trip
 * tested for both ES256 and RS256) to produce byte-identical, spec-correct
 * JWS output (ES256 needs the IEEE-P1363 R||S signature encoding, not
 * OpenSSL's default DER ASN.1 — see `signWithAlg` below).
 *
 * Management API base URL defaults to `https://api.<org>.code.storage`
 * (override with CODE_STORAGE_API_BASE for a non-standard cluster mapping);
 * the git remote host defaults to `<org>.code.storage` (override with
 * CODE_STORAGE_GIT_HOST). Git push/pull auth is embedded as HTTP Basic on the
 * remote — username literally `t`, password the JWT — expressed here as an
 * `Authorization: Basic` header (not baked into the URL) so it flows through
 * the SAME neutral `{url, headers}` shape + `http.extraHeader` credential
 * path the git proxy already uses for the GitHub backend (see
 * `basicAuthHeader` in ./types.ts and seed.ts's `.extraheader` injection).
 *
 * Endpoint + payload shapes below are transcribed from the LIVE docs
 * (code.storage/docs/reference/api/**), not the task's initial paraphrase —
 * the real paths are under `/api/repos`, not `/repositories`.
 */
import { type KeyObject, createPrivateKey, createSign } from 'node:crypto';
import { config } from '../../config';
import type {
  GitConnectionRef,
  GitHostBackend,
  GitScope,
  ProvisionInput,
  ProvisionedRepo,
  SeedFile,
  UpstreamGit,
} from './types';

export type CodeStorageScope = 'git:read' | 'git:write' | 'repo:write' | 'org:read';

export interface CodeStorageJwtOptions {
  /** Repo path this token is scoped to. Omit (or null) for an org-wide token (create-repo). */
  repo?: string | null;
  scopes: CodeStorageScope[];
  /** Token lifetime in seconds. Defaults to a short-lived management-call TTL. */
  ttlSeconds?: number;
  /** `sub` claim — agent identity, for the org's own audit logging. */
  subject?: string;
}

const DEFAULT_SUBJECT = 'kortix-api';
// Short-lived — minted fresh per management-API call (create/delete/commit),
// never persisted or reused.
const MGMT_TOKEN_TTL_SECONDS = 5 * 60;
// Longer-lived — embedded in a git remote credential a session or the CLI may
// hold onto for the lifetime of a clone/push (buildUpstream, createRepo's
// `initialToken`). Still far under the SDK helper's own 1-year default.
const GIT_TOKEN_TTL_SECONDS = 60 * 60;

function org(): string {
  return config.CODE_STORAGE_ORG.trim();
}

/**
 * Strip surrounding quotes (a secret stored as `"...PEM..."` double-encodes
 * the quotes into the value) and un-escape literal `\n` sequences — same
 * normalization as GitHub App keys (projects/github.ts's
 * `normalizeGitHubPrivateKey`), duplicated here rather than imported so this
 * backend has zero coupling to the GitHub one.
 */
function normalizeKeyPem(value: string): string {
  return value
    .trim()
    .replace(/^\s*(['"])([\s\S]*)\1\s*$/, '$2')
    .trim()
    .replace(/\\n/g, '\n');
}

function privateKeyPem(): string {
  return normalizeKeyPem(config.CODE_STORAGE_PRIVATE_KEY);
}

/** `https://api.<org>.code.storage` unless overridden. Trailing slash stripped. */
function apiBase(): string {
  const override = config.CODE_STORAGE_API_BASE.trim();
  const base = override || `https://api.${org()}.code.storage`;
  return base.replace(/\/+$/, '');
}

/** `<org>.code.storage` unless overridden — the git remote host. */
function gitHost(): string {
  return config.CODE_STORAGE_GIT_HOST.trim() || `${org()}.code.storage`;
}

interface LoadedKey {
  keyObject: KeyObject;
  alg: 'ES256' | 'RS256';
}

// Keyed by the raw PEM string so tests that swap CODE_STORAGE_PRIVATE_KEY
// between cases never see a stale cached key.
const keyCache = new Map<string, LoadedKey>();

function loadKey(pem: string): LoadedKey {
  const cached = keyCache.get(pem);
  if (cached) return cached;
  const keyObject = createPrivateKey(pem);
  let alg: 'ES256' | 'RS256';
  if (keyObject.asymmetricKeyType === 'ec') alg = 'ES256';
  else if (keyObject.asymmetricKeyType === 'rsa') alg = 'RS256';
  else {
    throw new Error(
      `code.storage: unsupported CODE_STORAGE_PRIVATE_KEY type "${keyObject.asymmetricKeyType}" ` +
        `(expected a PKCS8 PEM-encoded EC or RSA key)`,
    );
  }
  const loaded: LoadedKey = { keyObject, alg };
  keyCache.set(pem, loaded);
  return loaded;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Sign `data` with the given algorithm. ES256 (JWS/RFC 7518) requires the raw
 * 64-byte IEEE-P1363 R||S concatenation — `dsaEncoding: 'ieee-p1363'` is what
 * makes Node emit that instead of its default DER ASN.1 SEQUENCE, which a
 * spec-compliant JWT verifier (jose, code.storage's own server) would reject.
 * RS256 needs no such option — PKCS#1 v1.5 is already the JWS wire format.
 */
function signWithAlg(alg: 'ES256' | 'RS256', data: string, key: KeyObject): string {
  const signer = createSign(alg === 'ES256' ? 'SHA256' : 'RSA-SHA256');
  signer.update(data);
  signer.end();
  const signature =
    alg === 'ES256' ? signer.sign({ key, dsaEncoding: 'ieee-p1363' }) : signer.sign(key);
  return signature.toString('base64url');
}

/**
 * Mint a code.storage JWT. The ONE signing path every operation in this file
 * goes through — never construct or sign a token anywhere else.
 */
export function mintCodeStorageJwt(opts: CodeStorageJwtOptions): string {
  const orgId = org();
  const pem = privateKeyPem();
  if (!orgId || !pem) {
    throw new Error(
      'code.storage is not configured (set CODE_STORAGE_ORG and CODE_STORAGE_PRIVATE_KEY)',
    );
  }
  const { keyObject, alg } = loadKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? MGMT_TOKEN_TTL_SECONDS;
  const payload: Record<string, unknown> = {
    iss: orgId,
    sub: opts.subject || DEFAULT_SUBJECT,
    scopes: opts.scopes,
    iat: now,
    exp: now + ttl,
  };
  if (opts.repo) payload.repo = opts.repo;

  const header = base64UrlJson({ alg, typ: 'JWT' });
  const body = base64UrlJson(payload);
  const unsigned = `${header}.${body}`;
  const signature = signWithAlg(alg, unsigned, keyObject);
  return `${unsigned}.${signature}`;
}

/** `Authorization: Basic base64("t:<jwt>")` — the git-remote credential scheme (username literally `t`). */
export function codeStorageGitAuthHeader(jwt: string): Record<string, string> {
  const encoded = Buffer.from(`t:${jwt}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

function mgmtHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** RFC 9457 problem-details on most endpoints; commit-pack's own `{result:{message}}` shape on conflict. */
function extractErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown> & { result?: { message?: unknown } };
  const detail = b.detail ?? b.title ?? b.error ?? b.result?.message ?? b.message;
  return typeof detail === 'string' ? detail : null;
}

function codeStorageError(action: string, res: Response, body: unknown): Error {
  const detail = extractErrorDetail(body) || res.statusText || 'request failed';
  return new Error(`code.storage ${action} failed (${res.status}): ${detail}`);
}

/** Repo path segment (e.g. `team/project-alpha`) parsed from a code.storage `http_url` response field. */
function parseRepoPath(httpUrl: string): string | null {
  try {
    const path = new URL(httpUrl).pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    return path || null;
  } catch {
    return null;
  }
}

/** Clean (credential-free) git clone URL for a repo path — auth travels via `buildUpstream`'s headers. */
function buildCloneUrl(repoPath: string): string {
  return `https://${gitHost()}/${repoPath.replace(/^\/+/, '')}.git`;
}

interface CommitPackFile {
  path: string;
  content: string;
}

/**
 * POST .../commit-pack — code.storage's "create commit from files" endpoint
 * (application/x-ndjson: one metadata line, then one base64 blob_chunk line
 * per file). No local git checkout needed, unlike the GitHub backend's
 * `seedRepoViaGitPush`. `expected_head_sha` is intentionally omitted — per
 * the SDK docs, omitting it "allows unconditional fast-forward commits",
 * which is what an initial repo seed wants (no prior tip to race against).
 */
async function commitPack(
  repoPath: string,
  token: string,
  opts: { branch: string; message: string; files: SeedFile[] },
): Promise<void> {
  const author = { name: 'Kortix', email: 'noreply@kortix.ai' };
  const commitFiles: CommitPackFile[] = opts.files.map((f) => ({
    path: f.path,
    content: f.content,
  }));
  const metadataLine = JSON.stringify({
    metadata: {
      target_branch: opts.branch,
      commit_message: opts.message,
      author,
      files: commitFiles.map((f, i) => ({
        path: f.path,
        operation: 'upsert',
        content_id: `blob-${i}`,
        mode: '100644',
      })),
    },
  });
  const blobLines = commitFiles.map((f, i) =>
    JSON.stringify({
      blob_chunk: {
        content_id: `blob-${i}`,
        data: Buffer.from(f.content, 'utf8').toString('base64'),
        eof: true,
      },
    }),
  );
  const ndjson = `${[metadataLine, ...blobLines].join('\n')}\n`;

  const res = await fetch(`${apiBase()}/api/repos/${encodeURIComponent(repoPath)}/commit-pack`, {
    method: 'POST',
    headers: mgmtHeaders(token, { 'Content-Type': 'application/x-ndjson' }),
    body: ndjson,
  });
  if (!res.ok) {
    const body = await parseJsonBody(res);
    throw codeStorageError(`commit to ${repoPath}#${opts.branch}`, res, body);
  }
}

export const codeStorageBackend: GitHostBackend = {
  id: 'code-storage',

  async isConfigured(): Promise<boolean> {
    return Boolean(org() && privateKeyPem());
  },

  async createRepo(input: ProvisionInput): Promise<ProvisionedRepo> {
    // repo:write, org-wide (no `repo` claim — the repo doesn't exist yet).
    const token = mintCodeStorageJwt({
      scopes: ['repo:write'],
      ttlSeconds: MGMT_TOKEN_TTL_SECONDS,
    });
    const res = await fetch(`${apiBase()}/api/repos`, {
      method: 'POST',
      headers: mgmtHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        // `id`: a custom repo id/slug — documented on the SDK's `createRepo({id})`
        // (the management API "mirrors SDK primitives"); the scraped HTTP schema
        // doc doesn't enumerate it, so this is sent best-effort and ignored
        // harmlessly if the server doesn't honor it (we always fall back to
        // parsing the authoritative repo path out of the response `http_url`
        // below, never assume `id` was applied).
        id: input.slug,
        default_branch: input.defaultBranch,
      }),
    });
    const body = await parseJsonBody(res);
    if (!res.ok) throw codeStorageError('create repo', res, body);
    const created = (body ?? {}) as { repo_id?: unknown; http_url?: unknown };
    const repoId = created.repo_id ? String(created.repo_id) : null;
    const httpUrl = typeof created.http_url === 'string' ? created.http_url : null;
    const repoPath = (httpUrl && parseRepoPath(httpUrl)) || input.slug;

    return {
      provider: 'code-storage',
      upstreamUrl: buildCloneUrl(repoPath),
      externalRepoId: repoId,
      // code.storage repos aren't owner/name-namespaced like GitHub's — the
      // org is one global config value, not a per-repo field.
      repoOwner: null,
      repoName: repoPath,
      installationId: null,
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      // git:write (implies read, per the docs' scope table) — repo-scoped —
      // for the caller's seeding / CLI first-push step.
      initialToken: mintCodeStorageJwt({
        repo: repoPath,
        scopes: ['git:write', 'git:read'],
        ttlSeconds: GIT_TOKEN_TTL_SECONDS,
      }),
    };
  },

  async deleteRepo(ref: GitConnectionRef): Promise<void> {
    const repoPath = ref.repoName || ref.externalRepoId;
    if (!repoPath) return;
    // repo:write + per-repo authorization, per delete-repo's own docs (NOT
    // git:write — deleting is a repo-management op, not a git op).
    const token = mintCodeStorageJwt({
      repo: repoPath,
      scopes: ['repo:write'],
      ttlSeconds: MGMT_TOKEN_TTL_SECONDS,
    });
    const res = await fetch(`${apiBase()}/api/repos/${encodeURIComponent(repoPath)}`, {
      method: 'DELETE',
      headers: mgmtHeaders(token),
    });
    // 404 (already gone) / 409 (delete already in flight) are both a no-op
    // success from this backend's point of view — mirrors the idempotent
    // "best-effort" delete contract the rest of the codebase relies on.
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      const body = await parseJsonBody(res);
      throw codeStorageError('delete repo', res, body);
    }
  },

  buildUpstream(ref: GitConnectionRef, token: string | null, scope: GitScope): UpstreamGit {
    const repoPath = ref.repoName || undefined;
    // Honor an already-resolved token (forward-compat with a future caller
    // that mints one, e.g. via a scoped git-credential endpoint) — otherwise
    // self-mint. This is the normal path today: nothing upstream of
    // `GitHostBackend` yet knows how to resolve a code.storage credential
    // (`resolveProjectGitAuth` in projects/lib/git.ts is GitHub-only), so
    // `token` arrives as `null` and this backend mints its own, scoped to
    // `ref.repoName` and the requested read/write scope.
    const jwt =
      token ??
      mintCodeStorageJwt({
        repo: repoPath,
        scopes: scope === 'write' ? ['git:write', 'git:read'] : ['git:read'],
        ttlSeconds: GIT_TOKEN_TTL_SECONDS,
      });
    return {
      url: repoPath ? buildCloneUrl(repoPath) : ref.upstreamUrl,
      headers: codeStorageGitAuthHeader(jwt),
    };
  },

  async seedFiles(
    ref: GitConnectionRef,
    token: string,
    files: SeedFile[],
    opts: { branch: string; message: string; baseFiles?: SeedFile[] },
  ): Promise<void> {
    const repoPath = ref.repoName;
    if (!repoPath) throw new Error('code.storage seedFiles: connection ref is missing a repo path');
    // Same two-commit shape as `seedRepoViaGitPush` (github.ts's seed.ts): a
    // deterministic base-scaffold commit first, then the per-project files —
    // commit-pack does one commit per call, so issue two sequential requests.
    if (opts.baseFiles?.length) {
      await commitPack(repoPath, token, {
        branch: opts.branch,
        message: 'chore: scaffold Kortix project',
        files: opts.baseFiles,
      });
    }
    await commitPack(repoPath, token, {
      branch: opts.branch,
      message: opts.baseFiles?.length ? 'chore: project setup' : opts.message,
      files,
    });
  },
};
