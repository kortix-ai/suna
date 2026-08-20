import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { FastBootGitHint } from '../git/commits';
import {
  MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES,
  resolveFastBootGitHint,
} from '../git/commits';
import { resolveRemoteBranchTip } from '../git/branches';
import type { GitBackedProject } from '../git/types';
import { db } from '../../shared/db';
import { metadataMergeSubtree } from './metadata-merge';

export const FAST_BOOT_GIT_HINT_CACHE_VERSION = 1;

export interface CachedFastBootGitHint {
  version: typeof FAST_BOOT_GIT_HINT_CACHE_VERSION;
  ref: string;
  base_sha: string;
  bundle_base64: string;
  cached_at: string;
}

export function buildCachedFastBootGitHint(
  ref: string,
  hint: FastBootGitHint,
  cachedAt = new Date().toISOString(),
): CachedFastBootGitHint | null {
  if (!/^[0-9a-f]{40}$/.test(hint.baseSha)) return null;
  const bundle = hint.gitDeltaBundleBase64;
  if (
    !bundle ||
    bundle.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(bundle) ||
    Buffer.byteLength(bundle, 'utf8') > MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES
  ) {
    return null;
  }
  return {
    version: FAST_BOOT_GIT_HINT_CACHE_VERSION,
    ref,
    base_sha: hint.baseSha,
    bundle_base64: bundle,
    cached_at: cachedAt,
  };
}

export function readCachedFastBootGitHint(
  metadata: unknown,
  ref: string,
): FastBootGitHint | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const git = (metadata as { git?: unknown }).git;
  if (!git || typeof git !== 'object') return null;
  const raw = (git as { fast_boot?: unknown }).fast_boot;
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const candidate = buildCachedFastBootGitHint(
    typeof entry.ref === 'string' ? entry.ref : '',
    {
      baseSha: typeof entry.base_sha === 'string' ? entry.base_sha : '',
      gitDeltaBundleBase64:
        typeof entry.bundle_base64 === 'string' ? entry.bundle_base64 : undefined,
    },
    typeof entry.cached_at === 'string' ? entry.cached_at : '',
  );
  if (
    entry.version !== FAST_BOOT_GIT_HINT_CACHE_VERSION ||
    !candidate ||
    candidate.ref !== ref ||
    candidate.cached_at.length === 0
  ) {
    return null;
  }
  return {
    baseSha: candidate.base_sha,
    gitDeltaBundleBase64: candidate.bundle_base64,
  };
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
  persistHint: (
    projectId: string,
    ref: string,
    hint: FastBootGitHint,
  ) => Promise<unknown>;
}

const defaultDependencies: FastBootGitHintDependencies = {
  resolveRemoteTip: resolveRemoteBranchTip,
  resolveFreshHint: resolveFastBootGitHint,
  persistHint: persistFastBootGitHint,
};

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
  if (fresh.gitDeltaBundleBase64) {
    await dependencies.persistHint(project.projectId, ref, fresh).catch((error) => {
      console.warn('[git] fast-boot hint cache write failed', {
        projectId: project.projectId,
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return fresh;
}
