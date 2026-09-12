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
  /**
   * Does this pin GOVERN the start?
   *
   * False in `shadow`: the snapshot is resolved and verified out of band, but
   * the session keeps the legacy behaviour — Git-backed config reads, the
   * fresh-session Git hint, and create-time remote-branch publishing. A shadow
   * that changed any of those would not be a shadow.
   */
  governs: boolean;
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
  /** `$KORTIX_API_URL` for this deployment. Required for proxy delivery. */
  apiBase?: string;
}): Promise<SessionSnapshotOutcome> {
  const mode = repoSnapshotMode();
  if (mode === 'off') return { pinned: false, mode, miss: { reason: 'disabled' } };

  const identity = readRepoSnapshotRepository(input.project);
  if (!identity.repository) {
    return {
      pinned: false,
      mode,
      miss: {
        reason: 'unsupported_project',
        detail: identity.unsupportedReason ?? 'not GitHub-backed',
        githubBacked: identity.githubBacked,
      },
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
    // Proxy delivery needs both; presigned delivery ignores them.
    projectId: input.project.projectId,
    apiBase: input.apiBase,
  });
  if (!resolved.ok) return { pinned: false, mode, miss: resolved.miss };

  return {
    pinned: true,
    pin: {
      mode,
      governs: mode === 'prefer' || mode === 'required',
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

/**
 * Is this miss fatal for session creation?
 *
 * In `required` there is no automatic Git fallback, so a miss must surface as a
 * bounded, retryable preparation state — never as a silent fall-through to the
 * clone path, which would defeat the mode. `unsupported_project` is NOT
 * retryable: nothing about waiting makes a non-GitHub project snapshottable.
 */
export function requiredModeFailure(
  outcome: SessionSnapshotOutcome,
): { status: 409 | 503; code: string; message: string; retryable: boolean } | null {
  if (outcome.pinned || outcome.mode !== 'required') return null;
  switch (outcome.miss.reason) {
    case 'disabled':
      return null;
    case 'unsupported_project':
      // The policy is scoped to GITHUB-backed projects. A project that is not
      // GitHub-backed is out of scope entirely and must keep working exactly as
      // it does today — failing it closed would take an unrelated project type
      // down with a flag that was never meant to govern it.
      return outcome.miss.githubBacked
        ? {
            status: 409,
            code: 'REPO_SNAPSHOT_UNSUPPORTED_PROJECT',
            message: `repository snapshots are required but this GitHub project cannot be snapshotted: ${outcome.miss.detail}`,
            retryable: false,
          }
        : null;
    case 'failed':
      return {
        status: 503,
        code: 'REPO_SNAPSHOT_PREPARATION_FAILED',
        message: `snapshot preparation failed for ${outcome.miss.commitSha}: ${outcome.miss.detail}`,
        retryable: true,
      };
    default:
      return {
        status: 503,
        code: 'REPO_SNAPSHOT_PREPARING',
        message: `snapshot for ${outcome.miss.commitSha} is not prepared yet; retry once preparation completes`,
        retryable: true,
      };
  }
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
