/**
 * Pin one exact revision for a new session, with NO Git or GitHub network call.
 *
 * This is the replacement for the fresh-session Git hint on a prepared start.
 * The old path resolved the tip with `ls-remote`, refreshed the mirror and read
 * config files with `git show`. All three are gone here:
 *
 *   revision      -> `kortix.repo_snapshot_refs.desired_sha` (last OBSERVED tip)
 *   artifact      -> `kortix.repo_snapshots` + one signature
 *   config files  -> the published archive, through `source-reader.ts`
 *
 * Freshness is therefore "the latest authorized SHA the control plane has
 * observed", and the pin reports when that was observed and how. Startup cannot
 * prove an unobserved GitHub HEAD without a remote lookup, and pretending
 * otherwise is exactly the stale-revision substitution this design forbids. An
 * explicit-SHA request stays exact.
 */
import { manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { logger } from '../lib/logger';
import {
  DEFAULT_OPENCODE_CONFIG_DIR,
  safeOpencodeConfigDir,
} from '../projects/git/opencode-config-dir';
import type { ProjectRow } from '../projects/lib/serializers';
import {
  type RepoSnapshotBootDescriptor,
  type RepoSnapshotMiss,
  type RepoSnapshotMode,
  repoSnapshotMode,
  resolveSnapshotForRevision,
  snapshotSessionEnv,
} from './descriptor';
import { readRepoSnapshotRepository } from './identity';
import { readSnapshotFile, snapshotDirectoryExists } from './source-reader';
import { readRepoRef, type RepoSnapshotRow } from './store';

export interface SessionSnapshotPin {
  mode: RepoSnapshotMode;
  descriptor: RepoSnapshotBootDescriptor;
  row: RepoSnapshotRow;
  commitSha: string;
  /** When the control plane last observed this ref, and through which path. */
  observedAt: Date | null;
  observedVia: string | null;
  env: Record<string, string>;
}

export type SessionSnapshotOutcome =
  | { pinned: true; pin: SessionSnapshotPin }
  | { pinned: false; mode: RepoSnapshotMode; miss: RepoSnapshotMiss };

/**
 * Resolve the pin for a session.
 *
 * `requestedSha` wins when the caller named one: an explicit revision is exact
 * and is never replaced by the observed tip.
 */
export async function pinSessionSnapshot(input: {
  project: ProjectRow;
  ref: string;
  requestedSha?: string | null;
}): Promise<SessionSnapshotOutcome> {
  const mode = repoSnapshotMode();
  if (mode === 'off') return { pinned: false, mode, miss: { reason: 'disabled' } };

  const identity = readRepoSnapshotRepository(input.project);
  if (!identity.repository) {
    return {
      pinned: false,
      mode,
      miss: { reason: 'unsupported_project', detail: identity.unsupportedReason ?? 'not GitHub-backed' },
    };
  }
  const refRow = input.requestedSha
    ? null
    : await readRepoRef({ provider: 'github', repositoryId: identity.repository.repositoryId }, input.ref);
  const commitSha = (input.requestedSha ?? refRow?.desiredSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    return { pinned: false, mode, miss: { reason: 'not_prepared', commitSha: commitSha || '(unobserved)' } };
  }
  const resolved = await resolveSnapshotForRevision({
    repositoryId: identity.repository.repositoryId,
    commitSha,
  });
  if (!resolved.ok) return { pinned: false, mode, miss: resolved.miss };

  return {
    pinned: true,
    pin: {
      mode,
      descriptor: resolved.descriptor,
      row: resolved.row,
      commitSha,
      observedAt: refRow?.observedAt ?? null,
      observedVia: refRow?.observedVia ?? (input.requestedSha ? 'explicit' : null),
      env: snapshotSessionEnv(mode, resolved.descriptor),
    },
  };
}

/**
 * The OpenCode config dir at the pinned revision, read from the snapshot.
 *
 * Same rule as `resolveOpencodeConfigDirAtSha`, same return contract — `null`
 * means the revision ships no project OpenCode config — but every read comes
 * from the archive instead of `git show`.
 */
export async function resolveOpencodeConfigDirFromSnapshot(
  row: RepoSnapshotRow,
  manifestPath: string,
): Promise<string | null> {
  let configDir = DEFAULT_OPENCODE_CONFIG_DIR;
  for (const candidate of manifestCandidatePaths(manifestPath)) {
    const found = await readSnapshotFile(row, candidate.path);
    if (!found) continue;
    const parsed = parseManifestText(found.content, candidate.format);
    const opencode = parsed.opencode;
    if (opencode && typeof opencode === 'object' && !Array.isArray(opencode)) {
      configDir = safeOpencodeConfigDir((opencode as Record<string, unknown>).config_dir) ?? configDir;
    }
    break;
  }
  for (const filename of ['opencode.jsonc', 'opencode.json']) {
    if (await readSnapshotFile(row, `${configDir}/${filename}`)) return configDir;
  }
  // A config dir that exists but ships no opencode.json behaves as absent,
  // matching the Git-backed resolver exactly.
  if (await snapshotDirectoryExists(row, configDir)) return null;
  return null;
}

/**
 * The manifest at the pinned revision, in the shape `readManifestFromRepo`
 * returns, so `parseManifestString` and every downstream rule are unchanged.
 *
 * `sha` is the archive digest rather than a blob id: nothing downstream treats
 * it as a Git object, and deriving a blob id would need the Git object store
 * this path deliberately does not touch.
 */
export async function readManifestFromSnapshot(
  row: RepoSnapshotRow,
  manifestPath: string,
): Promise<{ path: string; content: string; sha: string; candidatePaths: string[]; commit: string } | null> {
  const candidates = manifestCandidatePaths(manifestPath).map((candidate) => candidate.path);
  for (const candidate of candidates) {
    const found = await readSnapshotFile(row, candidate);
    if (!found) continue;
    return {
      path: candidate,
      content: found.content,
      sha: row.archiveSha256 ?? '',
      candidatePaths: candidates,
      commit: row.commitSha,
    };
  }
  return null;
}

/** One structured line per prepared start, for the rollout coverage report. */
export function logSnapshotOutcome(
  outcome: SessionSnapshotOutcome,
  context: { projectId: string; sessionId: string; ref: string },
): void {
  if (outcome.pinned) {
    logger.info('[repo-snapshot] session pinned a prepared revision', {
      ...context,
      mode: outcome.pin.mode,
      commitSha: outcome.pin.commitSha,
      observedVia: outcome.pin.observedVia,
      observedAt: outcome.pin.observedAt?.toISOString() ?? null,
      compressedBytes: outcome.pin.descriptor.compressedBytes,
    });
    return;
  }
  if (outcome.miss.reason === 'disabled') return;
  logger.info('[repo-snapshot] session fell back', { ...context, mode: outcome.mode, ...outcome.miss });
}
