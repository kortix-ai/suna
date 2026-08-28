import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveRemoteBranchTip } from '../git/branches';
import type { FastBootGitHint } from '../git/commits';
import { MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES, resolveFastBootGitHint } from '../git/commits';
import type { GitBackedProject } from '../git/types';
import { metadataMergeSubtree } from './metadata-merge';

// v3: a delta may be REMOTE (parent known, bundle downloaded by the daemon) and
// the entry carries the OpenCode config dir at the tip. v2 entries are
// ignored — one extra mirror read per project, once.
export const FAST_BOOT_GIT_HINT_CACHE_VERSION = 3;

export interface CachedFastBootGitHint {
  version: typeof FAST_BOOT_GIT_HINT_CACHE_VERSION;
  ref: string;
  base_sha: string;
  /** Inline bundle, or '' when the delta is remote / absent. */
  bundle_base64: string;
  bundle_remote: boolean;
  /** '' when no delta boundary was resolved (tip == root, import, too deep). */
  parent_sha: string;
  parent_commit_base64: string;
  /** Relative dir, '' for "no project OpenCode config at this tip", absent = unknown. */
  opencode_config_dir?: string;
  cached_at: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
}

export function buildCachedFastBootGitHint(
  ref: string,
  hint: FastBootGitHint,
  cachedAt = new Date().toISOString(),
): CachedFastBootGitHint | null {
  if (!SHA_RE.test(hint.baseSha)) return null;
  const bundle = hint.gitDeltaBundleBase64 ?? '';
  const parentSha = hint.gitDeltaParentSha ?? '';
  const parentCommit = hint.gitDeltaParentCommitBase64 ?? '';
  const remote = hint.gitDeltaBundleRemote === true;
  const hasDelta = parentSha.length > 0;
  if (hasDelta) {
    if (!SHA_RE.test(parentSha) || !isCanonicalBase64(parentCommit)) return null;
    if (remote && bundle.length > 0) return null;
    if (!remote && !isCanonicalBase64(bundle)) return null;
    if (
      !remote &&
      Buffer.byteLength(bundle + parentCommit, 'utf8') > MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES
    ) {
      return null;
    }
  } else if (bundle.length > 0 || parentCommit.length > 0 || remote) {
    return null;
  }
  const entry: CachedFastBootGitHint = {
    version: FAST_BOOT_GIT_HINT_CACHE_VERSION,
    ref,
    base_sha: hint.baseSha,
    bundle_base64: hasDelta && !remote ? bundle : '',
    bundle_remote: hasDelta && remote,
    parent_sha: hasDelta ? parentSha : '',
    parent_commit_base64: hasDelta ? parentCommit : '',
    cached_at: cachedAt,
  };
  if (hint.opencodeConfigDir !== undefined) {
    entry.opencode_config_dir = hint.opencodeConfigDir ?? '';
  }
  return entry;
}

export function readCachedFastBootGitHint(metadata: unknown, ref: string): FastBootGitHint | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const git = (metadata as { git?: unknown }).git;
  if (!git || typeof git !== 'object') return null;
  const raw = (git as { fast_boot?: unknown }).fast_boot;
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (entry.version !== FAST_BOOT_GIT_HINT_CACHE_VERSION) return null;
  const str = (key: string): string => (typeof entry[key] === 'string' ? (entry[key] as string) : '');
  const parentSha = str('parent_sha');
  const remote = entry.bundle_remote === true;
  const hint: FastBootGitHint = { baseSha: str('base_sha') };
  if (parentSha) {
    hint.gitDeltaParentSha = parentSha;
    hint.gitDeltaParentCommitBase64 = str('parent_commit_base64');
    if (remote) hint.gitDeltaBundleRemote = true;
    else hint.gitDeltaBundleBase64 = str('bundle_base64');
  }
  if (typeof entry.opencode_config_dir === 'string') {
    hint.opencodeConfigDir = entry.opencode_config_dir === '' ? null : entry.opencode_config_dir;
  }
  const candidate = buildCachedFastBootGitHint(str('ref'), hint, str('cached_at'));
  if (!candidate || candidate.ref !== ref || candidate.cached_at.length === 0) return null;
  return hint;
}

export async function persistFastBootGitHint(
  projectId: string,
  ref: string,
  hint: FastBootGitHint,
): Promise<CachedFastBootGitHint | null> {
  const cached = buildCachedFastBootGitHint(ref, hint);
  if (!cached) return null;
  await db
    .update(projects)
    .set({
      metadata: metadataMergeSubtree('git', { fast_boot: cached }),
      updatedAt: new Date(),
    })
    .where(eq(projects.projectId, projectId));
  return cached;
}

interface FastBootGitHintDependencies {
  resolveRemoteTip: (project: GitBackedProject, ref: string) => Promise<string | null>;
  resolveFreshHint: (
    project: GitBackedProject,
    ref: string,
    forceRefresh: boolean,
  ) => Promise<FastBootGitHint>;
  persistHint: (projectId: string, ref: string, hint: FastBootGitHint) => Promise<unknown>;
}

const defaultDependencies: FastBootGitHintDependencies = {
  resolveRemoteTip: resolveRemoteBranchTip,
  resolveFreshHint: resolveFastBootGitHint,
  persistHint: persistFastBootGitHint,
};

/**
 * A cached hint is reused when the remote tip still equals its `base_sha`
 * (one `ls-remote`, no mirror refresh). Otherwise the mirror is refreshed and
 * the hint rebuilt; every buildable hint is persisted — even a bare
 * `{ baseSha, opencodeConfigDir }` — so the next create pays only the tip check.
 */
export async function resolveFastBootGitHintWithCache(
  project: GitBackedProject,
  ref: string,
  metadata: unknown,
  dependencies: FastBootGitHintDependencies = defaultDependencies,
): Promise<FastBootGitHint> {
  const cached = readCachedFastBootGitHint(metadata, ref);
  let forceRefresh = false;
  if (cached) {
    try {
      const remoteTip = await dependencies.resolveRemoteTip(project, ref);
      if (remoteTip === cached.baseSha) return cached;
      forceRefresh = true;
    } catch {
      forceRefresh = false;
    }
  }
  const fresh = await dependencies.resolveFreshHint(project, ref, forceRefresh);
  await dependencies.persistHint(project.projectId, ref, fresh).catch((error) => {
    console.warn('[git] fast-boot hint cache write failed', {
      projectId: project.projectId,
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return fresh;
}
