/**
 * Repository-snapshot format contract (Config Provider v1).
 *
 * Pure leaf module: identity normalization, object keys, and manifest
 * validation. No I/O, no database, no AWS. Both the publisher (`build.ts`,
 * `publish.ts`) and every reader (`descriptor.ts`, `source-reader.ts`, the
 * git-proxy route) resolve the same key from the same identity here, so a
 * rename never silently repoints one side.
 *
 * The daemon carries its own copy of the consumed half in
 * `apps/kortix-sandbox-agent-server/src/repo-snapshot.ts` — it compiles to a
 * standalone binary and takes no workspace dependency. `format-parity.test.ts`
 * fails when the two drift.
 */

export const REPO_SNAPSHOT_FORMAT = 'kortix.project-snapshot.v1';
/** Key segment. Fixed by the format; a future artifact kind gets its own. */
export const REPO_SNAPSHOT_KIND = 'project-snapshot-v1';
export const REPO_SNAPSHOT_LAYOUT_VERSION = 1;
export const REPO_SNAPSHOT_MANIFEST_NAME = 'manifest.json';
/** In-archive manifest copy, so an extracted tree is self-describing. */
export const REPO_SNAPSHOT_EMBEDDED_MANIFEST = '.git/kortix-project-snapshot.json';

export type RepoSnapshotCompression = 'gzip' | 'zstd';

export const REPO_SNAPSHOT_COMPRESSIONS: readonly RepoSnapshotCompression[] = ['gzip', 'zstd'];

/** Archive extension for a codec. The manifest and the object key always agree. */
export function archiveExtension(compression: RepoSnapshotCompression): string {
  return compression === 'zstd' ? 'tar.zst' : 'tar.gz';
}

export function isRepoSnapshotCompression(value: unknown): value is RepoSnapshotCompression {
  return value === 'gzip' || value === 'zstd';
}

export interface RepoSnapshotIdentity {
  provider: 'github';
  /** The PROVIDER's stable numeric repository id. Not a Kortix project id. */
  repositoryId: string;
  owner: string;
  repo: string;
  commitSha: string;
}

export interface RepoSnapshotManifest {
  format: typeof REPO_SNAPSHOT_FORMAT;
  source: {
    provider: 'github';
    repository_id: string;
    owner: string;
    repo: string;
    commit_sha: string;
    tree_sha: string;
  };
  payload: {
    key: string;
    compression: RepoSnapshotCompression;
    sha256: string;
    compressed_bytes: number;
    expanded_bytes: number;
    entry_count: number;
  };
  checkout: {
    git_metadata: 'sanitized-shallow';
    layout_version: number;
  };
  producer_version: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** GitHub owner/repo grammar. Deliberately stricter than GitHub itself. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REPOSITORY_ID_RE = /^[0-9]{1,20}$/;

export class RepoSnapshotIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoSnapshotIdentityError';
  }
}

/**
 * Validate and normalize the four identity components. Owner and repo are
 * lowercased because GitHub treats them case-insensitively and two casings of
 * one repository must not produce two objects. `repository_id` and
 * `commit_sha` are the parts that actually bind identity; owner/repo are the
 * human-readable prefix the brief requires and are re-checked on read.
 */
export function normalizeRepoSnapshotIdentity(input: {
  provider?: string;
  repositoryId: string | number | null | undefined;
  owner: string | null | undefined;
  repo: string | null | undefined;
  commitSha: string | null | undefined;
}): RepoSnapshotIdentity {
  const provider = (input.provider ?? 'github').trim().toLowerCase();
  if (provider !== 'github') {
    throw new RepoSnapshotIdentityError(`unsupported snapshot provider: ${provider}`);
  }
  const repositoryId = String(input.repositoryId ?? '').trim();
  if (!REPOSITORY_ID_RE.test(repositoryId)) {
    throw new RepoSnapshotIdentityError('repository_id must be the provider numeric id');
  }
  const owner = String(input.owner ?? '').trim().toLowerCase();
  if (!OWNER_RE.test(owner)) throw new RepoSnapshotIdentityError(`invalid repository owner: ${owner}`);
  const repo = String(input.repo ?? '').trim().toLowerCase().replace(/\.git$/, '');
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new RepoSnapshotIdentityError(`invalid repository name: ${repo}`);
  }
  const commitSha = String(input.commitSha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(commitSha)) {
    throw new RepoSnapshotIdentityError('commit_sha must be a full 40-hex commit SHA');
  }
  return { provider: 'github', repositoryId, owner, repo, commitSha };
}

/** `<owner>/<repo>/<full-commit-sha>/<repository-id>/project-snapshot-v1/`. */
export function snapshotPrefix(identity: RepoSnapshotIdentity): string {
  return `${identity.owner}/${identity.repo}/${identity.commitSha}/${identity.repositoryId}/${REPO_SNAPSHOT_KIND}/`;
}

export function manifestKey(identity: RepoSnapshotIdentity): string {
  return `${snapshotPrefix(identity)}${REPO_SNAPSHOT_MANIFEST_NAME}`;
}

/** The archive sits beside its manifest, named by its own compressed digest. */
export function payloadKey(
  identity: RepoSnapshotIdentity,
  archiveSha256: string,
  compression: RepoSnapshotCompression,
): string {
  if (!SHA256_RE.test(archiveSha256)) {
    throw new RepoSnapshotIdentityError('archive sha256 must be 64 lowercase hex characters');
  }
  return `${snapshotPrefix(identity)}${archiveSha256}.${archiveExtension(compression)}`;
}

export interface RepoSnapshotLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxEntryCount: number;
}

export const REPO_SNAPSHOT_DEFAULT_LIMITS: RepoSnapshotLimits = {
  maxCompressedBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxEntryCount: 500_000,
};

export class RepoSnapshotManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoSnapshotManifestError';
  }
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RepoSnapshotManifestError(`manifest ${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Parse an untrusted manifest document. Every field is checked; nothing is
 * defaulted. The caller still has to bind it to an AUTHENTICATED identity —
 * a manifest that validates only proves it is well formed, never that it
 * describes the revision the session asked for.
 */
export function parseRepoSnapshotManifest(raw: unknown): RepoSnapshotManifest {
  const doc = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!doc || typeof doc !== 'object') throw new RepoSnapshotManifestError('manifest is not an object');
  const m = doc as Record<string, any>;
  if (m.format !== REPO_SNAPSHOT_FORMAT) {
    throw new RepoSnapshotManifestError(`manifest format mismatch: ${String(m.format)}`);
  }
  const source = m.source;
  if (!source || typeof source !== 'object') throw new RepoSnapshotManifestError('manifest source missing');
  const identity = normalizeRepoSnapshotIdentity({
    provider: source.provider,
    repositoryId: source.repository_id,
    owner: source.owner,
    repo: source.repo,
    commitSha: source.commit_sha,
  });
  const treeSha = String(source.tree_sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(treeSha)) throw new RepoSnapshotManifestError('manifest tree_sha is invalid');

  const payload = m.payload;
  if (!payload || typeof payload !== 'object') throw new RepoSnapshotManifestError('manifest payload missing');
  if (!isRepoSnapshotCompression(payload.compression)) {
    throw new RepoSnapshotManifestError(`manifest compression is unsupported: ${String(payload.compression)}`);
  }
  const sha256 = String(payload.sha256 ?? '').trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new RepoSnapshotManifestError('manifest payload sha256 is invalid');
  const key = String(payload.key ?? '');
  const expectedKey = payloadKey(identity, sha256, payload.compression);
  if (key !== expectedKey) {
    throw new RepoSnapshotManifestError('manifest payload key does not match its own identity');
  }
  const checkout = m.checkout;
  if (!checkout || typeof checkout !== 'object' || checkout.git_metadata !== 'sanitized-shallow') {
    throw new RepoSnapshotManifestError('manifest checkout metadata is unsupported');
  }
  const layoutVersion = requirePositiveInt(checkout.layout_version, 'checkout.layout_version');
  if (layoutVersion !== REPO_SNAPSHOT_LAYOUT_VERSION) {
    throw new RepoSnapshotManifestError(`manifest layout_version ${layoutVersion} is unsupported`);
  }
  const producerVersion = String(m.producer_version ?? '');
  if (!producerVersion) throw new RepoSnapshotManifestError('manifest producer_version is missing');

  return {
    format: REPO_SNAPSHOT_FORMAT,
    source: {
      provider: 'github',
      repository_id: identity.repositoryId,
      owner: identity.owner,
      repo: identity.repo,
      commit_sha: identity.commitSha,
      tree_sha: treeSha,
    },
    payload: {
      key,
      compression: payload.compression,
      sha256,
      compressed_bytes: requirePositiveInt(payload.compressed_bytes, 'payload.compressed_bytes'),
      expanded_bytes: requirePositiveInt(payload.expanded_bytes, 'payload.expanded_bytes'),
      entry_count: requirePositiveInt(payload.entry_count, 'payload.entry_count'),
    },
    checkout: { git_metadata: 'sanitized-shallow', layout_version: layoutVersion },
    producer_version: producerVersion,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new RepoSnapshotManifestError('manifest is not valid JSON');
  }
}

/**
 * Does an authenticated manifest describe the revision that was asked for?
 * Repository id, SHA, key and digest must all agree; any disagreement is an
 * identity failure, never a reason to fall back to a different revision.
 */
export function assertManifestMatchesIdentity(
  manifest: RepoSnapshotManifest,
  identity: RepoSnapshotIdentity,
): void {
  if (
    manifest.source.repository_id !== identity.repositoryId ||
    manifest.source.owner !== identity.owner ||
    manifest.source.repo !== identity.repo ||
    manifest.source.commit_sha !== identity.commitSha
  ) {
    throw new RepoSnapshotManifestError('snapshot manifest identity does not match the pinned revision');
  }
  if (manifest.payload.key !== payloadKey(identity, manifest.payload.sha256, manifest.payload.compression)) {
    throw new RepoSnapshotManifestError('snapshot manifest payload key does not match the pinned revision');
  }
}

/**
 * Canonical manifest bytes. Key order is fixed and the document ends with a
 * newline, so republishing the same revision produces byte-identical content
 * and a conditional create can be answered by comparing the stored object.
 */
export function serializeRepoSnapshotManifest(manifest: RepoSnapshotManifest): string {
  return `${JSON.stringify(
    {
      format: manifest.format,
      source: {
        provider: manifest.source.provider,
        repository_id: manifest.source.repository_id,
        owner: manifest.source.owner,
        repo: manifest.source.repo,
        commit_sha: manifest.source.commit_sha,
        tree_sha: manifest.source.tree_sha,
      },
      payload: {
        key: manifest.payload.key,
        compression: manifest.payload.compression,
        sha256: manifest.payload.sha256,
        compressed_bytes: manifest.payload.compressed_bytes,
        expanded_bytes: manifest.payload.expanded_bytes,
        entry_count: manifest.payload.entry_count,
      },
      checkout: manifest.checkout,
      producer_version: manifest.producer_version,
    },
    null,
    2,
  )}\n`;
}
