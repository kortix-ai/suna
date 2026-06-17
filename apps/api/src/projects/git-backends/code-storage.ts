/**
 * code.storage (Pierre) managed git backend — see ./code-storage.md.
 *
 * Managed repos live on code.storage instead of a GitHub org. Auth is a
 * customer-signed ES256 JWT: WE hold the EC P-256 private key
 * (MANAGED_GIT_CODESTORAGE_PRIVATE_KEY) and code.storage verifies it against the
 * public key registered in the Pierre Admin Panel. Unlike the GitHub backend,
 * there is no installation-token round-trip — `buildUpstream` signs a
 * short-TTL, repo-scoped JWT locally (synchronous, no network, no token store).
 *
 * URL/host shapes below follow the public docs but MUST be confirmed against the
 * real org during integration (the docs show both `<org>.code.storage/<id>` and
 * `git.code.storage/<org>/<id>`). All host/path construction is centralized in
 * the `cs*` helpers so a correction is a one-line change. `createRepo` already
 * prefers the `http_url` returned by the API as the canonical clone URL.
 */
import { createSign } from 'node:crypto';
import type {
  GitConnectionRef,
  GitHostBackend,
  GitScope,
  ProvisionInput,
  ProvisionedRepo,
  SeedFile,
  UpstreamGit,
} from './types';

// ── env ──────────────────────────────────────────────────────────────────────
function csOrg(): string | null {
  return process.env.MANAGED_GIT_CODESTORAGE_ORG?.trim() || null;
}
function csPrivateKey(): string | null {
  const raw = process.env.MANAGED_GIT_CODESTORAGE_PRIVATE_KEY?.trim();
  if (!raw) return null;
  // Env transports (shell `eval` of `dotenvx --format eval`, AWS Secrets
  // Manager, .env files) routinely deliver the PEM with literal `\n` and/or no
  // trailing newline → BoringSSL `BAD_END_LINE`. Normalize to real newlines,
  // strip CRs, ensure a trailing newline. (Mirrors `normalizeGitHubPrivateKey`.)
  const key = raw.replace(/\\n/g, '\n').replace(/\r/g, '');
  return key.endsWith('\n') ? key : `${key}\n`;
}
/** API root (no trailing `/api`). e.g. `https://api.<org>.code.storage`. */
function csApiRoot(): string {
  const override = process.env.MANAGED_GIT_CODESTORAGE_API_URL?.trim();
  const root = override || `https://api.${requireOrg()}.code.storage`;
  return root.replace(/\/+$/, '').replace(/\/api$/, '');
}
/** Git transport host. e.g. `<org>.code.storage`. */
function csGitHost(): string {
  return process.env.MANAGED_GIT_CODESTORAGE_GIT_HOST?.trim() || `${requireOrg()}.code.storage`;
}

function requireOrg(): string {
  const org = csOrg();
  if (!org) throw new Error('code.storage not configured (MANAGED_GIT_CODESTORAGE_ORG)');
  return org;
}
function requireKey(): string {
  const key = csPrivateKey();
  if (!key) throw new Error('code.storage not configured (MANAGED_GIT_CODESTORAGE_PRIVATE_KEY)');
  return key;
}

// ── repo id / url helpers ─────────────────────────────────────────────────────
/**
 * The repo's human id == the Kortix projectId (a UUID, globally unique). The org
 * is the `<org>.code.storage` subdomain, so no extra namespace is needed; the
 * git path + API path + JWT `repo` claim all use this id verbatim.
 */
function csRepoId(projectId: string): string {
  return projectId;
}
function csCloneUrl(repoId: string): string {
  return `https://${csGitHost()}/${repoId}.git`;
}
/** Recover the repo id (`kortix/<id>`) from a stored clone URL. */
function repoIdFromUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  } catch {
    return url;
  }
}

// ── ES256 JWT ──────────────────────────────────────────────────────────────────
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

interface JwtClaims {
  /** Target repo id; omit only for org-wide tokens (e.g. repo:write to create). */
  repo?: string;
  scopes: string[];
  ttlSec: number;
  /** Audit identity. */
  sub?: string;
}

/**
 * Sign an ES256 JWT. NOTE: Node's EC signatures are DER by default, but
 * JOSE/ES256 requires the raw R||S (IEEE P1363) form — hence `dsaEncoding`.
 */
function signCsJwt(claims: JwtClaims, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iss: requireOrg(),
    sub: claims.sub ?? 'kortix-api',
    scopes: claims.scopes,
    iat: now - 30,
    exp: now + claims.ttlSec,
  };
  if (claims.repo) payload.repo = claims.repo;

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: requireKey(), dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

/** Basic-auth header for git transport: username `t`, password = signed JWT. */
function csGitAuthHeader(jwt: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`t:${jwt}`).toString('base64')}` };
}

/**
 * Mint a fresh repo-scoped code.storage git JWT — for host-side `git` that must
 * embed creds in the URL (the mirror; direct-mode clone-credential). Short-lived;
 * callers mint per use. Throws if code.storage isn't configured.
 */
export function mintCodeStorageGitToken(repoId: string, scope: GitScope = 'write', ttlSec = 3600): string {
  return signCsJwt({
    repo: repoId,
    scopes: scope === 'write' ? ['git:read', 'git:write'] : ['git:read'],
    ttlSec,
  });
}

/** True when a host is served by code.storage (so git must use creds-in-URL, not extraheader). */
export function isCodeStorageHost(host: string): boolean {
  return host === 'code.storage' || host.endsWith('.code.storage');
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
async function csFetch<T>(
  path: string,
  init: { method?: string; body?: unknown },
  jwt: string,
): Promise<T> {
  const url = `${csApiRoot()}/api${path}`;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* non-JSON body */
    }
    throw new Error(`code.storage ${init.method ?? 'GET'} ${path} → ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** POST a pre-serialized body (e.g. NDJSON commit-pack) with an explicit content-type. */
async function csPostRaw(path: string, body: string, contentType: string, jwt: string): Promise<void> {
  const res = await fetch(`${csApiRoot()}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* non-JSON body */
    }
    throw new Error(`code.storage POST ${path} → ${res.status}: ${message}`);
  }
}

interface CreateRepoResponse {
  /** Opaque internal id (reference only — NOT used to address the repo). */
  repo_id?: string;
  /** Human id the git/API paths use; echoes the `id` we sent. */
  url?: string;
  /** Full clone URL, when the API returns one. */
  http_url?: string;
  message?: string;
}

// ── backend ──────────────────────────────────────────────────────────────────
export const codeStorageBackend: GitHostBackend = {
  id: 'codestorage',

  async isConfigured(): Promise<boolean> {
    return Boolean(csOrg() && csPrivateKey());
  },

  async createRepo(input: ProvisionInput): Promise<ProvisionedRepo> {
    const repoId = csRepoId(input.projectId);
    // `repo:write` MUST carry the `repo` claim set to the id being created
    // (verified against the live API — org-wide repo:write tokens are rejected).
    const res = await csFetch<CreateRepoResponse>(
      '/repos',
      { method: 'POST', body: { id: repoId, default_branch: input.defaultBranch } },
      signCsJwt({ repo: repoId, scopes: ['repo:write'], ttlSec: 120 }),
    );
    // The addressable human id comes back as `url` (get/list) or `http_url`
    // (create — a bare id in practice, not a URL). Always derive the clone URL
    // from it, unless the API ever returns a genuine absolute http(s) URL.
    const httpUrlIsAbsolute = !!res.http_url && /^https?:\/\//i.test(res.http_url);
    const resolvedId = res.url || (httpUrlIsAbsolute ? null : res.http_url) || repoId;
    const upstreamUrl = httpUrlIsAbsolute
      ? res.http_url!.endsWith('.git')
        ? res.http_url!
        : `${res.http_url}.git`
      : csCloneUrl(resolvedId);
    return {
      provider: this.id,
      upstreamUrl,
      externalRepoId: res.repo_id ?? null,
      repoOwner: csOrg(),
      repoName: resolvedId,
      installationId: null,
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      // A real repo-scoped git:write JWT — satisfies the route's seeding guard
      // and is a usable push credential for the CLI's first push / prebuild clone.
      initialToken: signCsJwt({ repo: resolvedId, scopes: ['git:read', 'git:write'], ttlSec: 3600 }),
    };
  },

  async deleteRepo(ref: GitConnectionRef): Promise<void> {
    const repoId = ref.repoName ?? repoIdFromUrl(ref.upstreamUrl);
    if (!repoId) return;
    await csFetch<unknown>(
      `/repos/${repoId}`,
      { method: 'DELETE' },
      signCsJwt({ repo: repoId, scopes: ['repo:write'], ttlSec: 120 }),
    );
  },

  /**
   * Self-signs a short-TTL, repo-scoped JWT and returns git basic-auth headers.
   * `_token` is ignored — `resolveProjectGitAuth` returns no token for
   * code.storage; the credential is minted here.
   */
  buildUpstream(ref: GitConnectionRef, _token: string | null, scope: GitScope): UpstreamGit {
    const repoId = ref.repoName ?? repoIdFromUrl(ref.upstreamUrl);
    const jwt = signCsJwt({
      repo: repoId,
      scopes: scope === 'write' ? ['git:read', 'git:write'] : ['git:read'],
      ttlSec: 300,
    });
    return { url: ref.upstreamUrl, headers: csGitAuthHeader(jwt) };
  },

  /**
   * Seed the FIRST commit via the commit-pack API (NDJSON: one metadata line +
   * one base64 `blob_chunk` per file), NOT `git push`. code.storage writes the
   * initial commit to an empty repo through this endpoint; it's also network-
   * robust (a plain fetch, no git subprocess / temp clone).
   */
  async seedFiles(
    ref: GitConnectionRef,
    _token: string,
    files: SeedFile[],
    opts: { branch: string; message: string },
  ): Promise<void> {
    const repoId = ref.repoName ?? repoIdFromUrl(ref.upstreamUrl);
    const metadata = {
      metadata: {
        target_branch: opts.branch,
        commit_message: opts.message,
        author: { name: 'Kortix', email: 'noreply@kortix.ai' },
        files: files.map((f, i) => ({
          path: f.path,
          operation: 'upsert',
          content_id: `b${i}`,
          mode: '100644',
        })),
      },
    };
    const lines = [
      JSON.stringify(metadata),
      ...files.map((f, i) =>
        JSON.stringify({
          blob_chunk: { content_id: `b${i}`, data: Buffer.from(f.content).toString('base64'), eof: true },
        }),
      ),
    ];
    await csPostRaw(
      `/repos/${repoId}/commit-pack`,
      `${lines.join('\n')}\n`,
      'application/x-ndjson',
      signCsJwt({ repo: repoId, scopes: ['git:write'], ttlSec: 300 }),
    );
  },

  /** Credential-embedded push URL for external/legacy contexts (a SECRET — never log). */
  async authedPushUrl(ref: GitConnectionRef): Promise<string> {
    const repoId = ref.repoName ?? repoIdFromUrl(ref.upstreamUrl);
    const jwt = signCsJwt({ repo: repoId, scopes: ['git:read', 'git:write'], ttlSec: 600 });
    const u = new URL(ref.upstreamUrl);
    u.username = 't';
    u.password = jwt;
    return u.toString();
  },

  // inviteCollaborator: N/A — code.storage has no per-user host accounts.
};
