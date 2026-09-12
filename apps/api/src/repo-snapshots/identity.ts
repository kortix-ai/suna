/**
 * Resolve a project's GitHub repository identity for snapshot addressing.
 *
 * The identity prefix — provider, numeric repository id, owner, repo — is
 * resolved ONCE, at connection or preparation time, and cached on the project.
 * It is never looked up during a prepared session start: that would put a
 * GitHub API call back on the critical path this feature exists to remove.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { getProjectGitRemote, resolveUpstreamUrl, withProjectGitAuth } from '../projects/lib/git';
import { metadataMergeSubtree } from '../projects/lib/metadata-merge';
import { getRepo, parseGitHubRepoUrl } from '../projects/github';
import type { ProjectRow } from '../projects/lib/serializers';
import { db } from '../shared/db';
import {
  RepoSnapshotIdentityError,
  normalizeRepoSnapshotIdentity,
  type RepoSnapshotIdentity,
} from './format';

/** Identity without a revision. Adding a commit SHA makes it addressable. */
export type RepoSnapshotRepository = Omit<RepoSnapshotIdentity, 'commitSha'>;

export interface RepoIdentityResolution {
  repository: RepoSnapshotRepository | null;
  /** Why this project cannot be snapshotted, for the coverage report. */
  unsupportedReason?: string;
}

function upstreamGitHubCoordinates(project: ProjectRow): { owner: string; repo: string } | null {
  const remote = getProjectGitRemote(project);
  if (remote.repoOwner && remote.repoName) return { owner: remote.repoOwner, repo: remote.repoName };
  // `resolveUpstreamUrl` is the pure, DB-free derivation. The async
  // `resolveProjectUpstream` mints a credential, which this path must not do.
  return parseGitHubRepoUrl(resolveUpstreamUrl(project, remote));
}

/** The provider repository id already recorded on the project, if any. */
export function recordedRepositoryId(project: ProjectRow): string | null {
  const remote = getProjectGitRemote(project);
  const value = (remote.externalRepoId ?? '').trim();
  return /^[0-9]{1,20}$/.test(value) ? value : null;
}

/**
 * Read the identity from what is already stored. No network, no GitHub token.
 * This is the ONLY variant a session-create path may call.
 */
export function readRepoSnapshotRepository(project: ProjectRow): RepoIdentityResolution {
  const remote = getProjectGitRemote(project);
  if (remote.provider !== 'github') {
    return { repository: null, unsupportedReason: `provider ${remote.provider} is not GitHub` };
  }
  const coordinates = upstreamGitHubCoordinates(project);
  if (!coordinates) {
    return { repository: null, unsupportedReason: 'project has no resolvable GitHub owner/repo' };
  }
  const repositoryId = recordedRepositoryId(project);
  if (!repositoryId) {
    return { repository: null, unsupportedReason: 'project has no recorded GitHub repository id' };
  }
  try {
    const identity = normalizeRepoSnapshotIdentity({
      provider: 'github',
      repositoryId,
      owner: coordinates.owner,
      repo: coordinates.repo,
      commitSha: '0'.repeat(40),
    });
    return { repository: { provider: 'github', repositoryId, owner: identity.owner, repo: identity.repo } };
  } catch (error) {
    const message = error instanceof RepoSnapshotIdentityError ? error.message : String(error);
    return { repository: null, unsupportedReason: message };
  }
}

/**
 * Resolve the identity, reaching GitHub once when the repository id was never
 * recorded, and persist what it learns.
 *
 * Background use only: import, link, backfill, reconciliation and the publisher
 * worker. A resolved id is written to project metadata so every later read —
 * including every session start — is a pure database read.
 */
export async function ensureRepoSnapshotRepository(
  project: ProjectRow,
): Promise<RepoIdentityResolution> {
  const cached = readRepoSnapshotRepository(project);
  if (cached.repository || cached.unsupportedReason !== 'project has no recorded GitHub repository id') {
    return cached;
  }
  const coordinates = upstreamGitHubCoordinates(project);
  if (!coordinates) return { repository: null, unsupportedReason: 'project has no resolvable GitHub owner/repo' };
  try {
    const authed = await withProjectGitAuth(project);
    const repo = await getRepo({
      owner: coordinates.owner,
      repo: coordinates.repo,
      auth: authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined,
    });
    const identity = normalizeRepoSnapshotIdentity({
      provider: 'github',
      repositoryId: repo.id,
      owner: coordinates.owner,
      repo: coordinates.repo,
      commitSha: '0'.repeat(40),
    });
    await db
      .update(projects)
      .set({
        metadata: metadataMergeSubtree('git', { external_repo_id: identity.repositoryId }),
        updatedAt: new Date(),
      })
      .where(eq(projects.projectId, project.projectId));
    logger.info('[repo-snapshot] recorded repository id', {
      projectId: project.projectId,
      repositoryId: identity.repositoryId,
    });
    return {
      repository: {
        provider: 'github',
        repositoryId: identity.repositoryId,
        owner: identity.owner,
        repo: identity.repo,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { repository: null, unsupportedReason: `GitHub repository lookup failed: ${message}` };
  }
}

export function withCommit(
  repository: RepoSnapshotRepository,
  commitSha: string,
): RepoSnapshotIdentity {
  return normalizeRepoSnapshotIdentity({ ...repository, commitSha });
}
