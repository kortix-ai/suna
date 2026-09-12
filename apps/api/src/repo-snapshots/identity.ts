/**
 * Resolve a project's GitHub repository identity for snapshot addressing.
 *
 * The identity prefix — provider, numeric repository id, owner, repo — is
 * resolved ONCE, at connection or preparation time, and cached on the project.
 * It is never looked up during a prepared session start: that would put a
 * GitHub API call back on the critical path this feature exists to remove.
 */
import { projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
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
  /**
   * Is this a GitHub-backed project at all?
   *
   * Distinct from `repository`: a GitHub project with no recorded repository id
   * is in scope and merely unprepared, while a GitLab or generic project is out
   * of scope entirely and must keep its existing behaviour under every mode.
   */
  githubBacked: boolean;
}

function upstreamGitHubCoordinates(project: ProjectRow): { owner: string; repo: string } | null {
  const remote = getProjectGitRemote(project);
  if (remote.repoOwner && remote.repoName) return { owner: remote.repoOwner, repo: remote.repoName };
  // `resolveUpstreamUrl` is the pure, DB-free derivation. The async
  // `resolveProjectUpstream` mints a credential, which this path must not do.
  return parseGitHubRepoUrl(resolveUpstreamUrl(project, remote));
}

/**
 * `getProjectGitRemote`'s subtree precedence, as SQL.
 *
 * It reads `metadata.git` whenever that key exists and falls back to the legacy
 * `metadata.github` only when it does not. EVERY query that selects projects by
 * git identity must use these, or it silently excludes every legacy project —
 * which then keeps its credentials and its repository id and is still never
 * reconciled, published or webhook-matched.
 */
export const effectiveGitSubtreeSql = sql`(case when ${projects.metadata} ? 'git'
  then ${projects.metadata} -> 'git'
  else coalesce(${projects.metadata} -> 'github', '{}'::jsonb) end)`;

/** The repository id `getProjectGitRemote` would read. `repo_id` is the legacy spelling. */
export const recordedRepositoryIdSql = sql`coalesce(
  nullif(${effectiveGitSubtreeSql} ->> 'external_repo_id', ''),
  nullif(${effectiveGitSubtreeSql} ->> 'repo_id', '')
)`;

/** Exactly the projects `getProjectGitRemote` reports as GitHub-backed. */
export const githubBackedProjectsSql = sql`(
  ${projects.metadata} -> 'git' ->> 'provider' = 'github'
  or (not (${projects.metadata} ? 'git') and ${projects.metadata} ? 'github')
)`;

/** Last snapshot-discovery attempt, from whichever subtree is in effect. */
export const discoveryMarkerSql = sql`coalesce(${effectiveGitSubtreeSql} ->> 'snapshot_discovery_at', '')`;

/**
 * Which metadata subtree holds this project's git bookkeeping.
 *
 * `getProjectGitRemote` reads `metadata.git` FIRST and only falls back to the
 * legacy `metadata.github` when `git` is absent. Writing a partial `git`
 * subtree onto a legacy project therefore SHADOWS the legacy one completely:
 * the remote degrades to provider `generic` with auth `none`, and the project
 * silently loses both its repository id and its credential routing. Every
 * writer here must target the subtree the project already uses.
 */
export function gitMetadataSubtree(project: ProjectRow): 'git' | 'github' {
  const meta = (project.metadata ?? {}) as Record<string, unknown>;
  if (meta.git && typeof meta.git === 'object') return 'git';
  return meta.github ? 'github' : 'git';
}

/**
 * The sub-patch that records a repository id in the shape this project uses.
 *
 * Composed with `metadataMergeSubtree` at the write site rather than returning
 * the whole expression, so the sanctioned atomic-merge helper stays visible to
 * the FIX-J guard in `projects/lib/metadata-merge.test.ts`.
 */
export function repositoryIdFields(project: ProjectRow, repositoryId: string): Record<string, string> {
  // The legacy shape spells it `repo_id`; `getProjectGitRemote` reads exactly
  // that key and nothing else for a legacy project.
  return gitMetadataSubtree(project) === 'git'
    ? { external_repo_id: repositoryId }
    : { repo_id: repositoryId };
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
    return {
      repository: null,
      unsupportedReason: `provider ${remote.provider} is not GitHub`,
      githubBacked: false,
    };
  }
  const coordinates = upstreamGitHubCoordinates(project);
  if (!coordinates) {
    return {
      repository: null,
      unsupportedReason: 'project has no resolvable GitHub owner/repo',
      githubBacked: true,
    };
  }
  const repositoryId = recordedRepositoryId(project);
  if (!repositoryId) {
    return {
      repository: null,
      unsupportedReason: 'project has no recorded GitHub repository id',
      githubBacked: true,
    };
  }
  try {
    const identity = normalizeRepoSnapshotIdentity({
      provider: 'github',
      repositoryId,
      owner: coordinates.owner,
      repo: coordinates.repo,
      commitSha: '0'.repeat(40),
    });
    return {
      repository: { provider: 'github', repositoryId, owner: identity.owner, repo: identity.repo },
      githubBacked: true,
    };
  } catch (error) {
    const message = error instanceof RepoSnapshotIdentityError ? error.message : String(error);
    return { repository: null, unsupportedReason: message, githubBacked: true };
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
  if (!coordinates) {
    return {
      repository: null,
      unsupportedReason: 'project has no resolvable GitHub owner/repo',
      githubBacked: true,
    };
  }
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
        metadata: metadataMergeSubtree(
          gitMetadataSubtree(project),
          repositoryIdFields(project, identity.repositoryId),
        ),
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
      githubBacked: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repository: null,
      unsupportedReason: `GitHub repository lookup failed: ${message}`,
      githubBacked: true,
    };
  }
}

/**
 * Branches a push touched before this project had a repository id.
 *
 * The ref table is keyed by repository id, so until one is recorded there is
 * nowhere to store a pushed branch — and a transient failure of that very
 * lookup dropped every non-default branch of the push with it. They are parked
 * on the PROJECT instead, which is the only key that exists at that moment, and
 * replayed as soon as an identity is known.
 *
 * Bounded, because this is metadata on a hot row: a bulk push parks its first
 * `MAX_PENDING_REFS` branches and the rest are covered by the next push or the
 * default-branch repair.
 */
const MAX_PENDING_REFS = 100;

export function pendingPushedRefs(project: ProjectRow): string[] {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  const subtree = meta[gitMetadataSubtree(project)];
  const raw = subtree?.snapshot_pending_refs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
}

/** The sub-patch that parks these branches, merged with anything already parked. */
export function pendingPushedRefsFields(
  project: ProjectRow,
  refs: string[],
): Record<string, unknown> {
  const merged = [
    ...new Set([...pendingPushedRefs(project), ...refs.map((ref) => ref.replace(/^refs\/heads\//, ''))]),
  ].slice(0, MAX_PENDING_REFS);
  return { snapshot_pending_refs: merged };
}

/** The sub-patch that clears them, once they have somewhere durable to live. */
export function clearPendingPushedRefsFields(): Record<string, unknown> {
  return { snapshot_pending_refs: null };
}

export function withCommit(
  repository: RepoSnapshotRepository,
  commitSha: string,
): RepoSnapshotIdentity {
  return normalizeRepoSnapshotIdentity({ ...repository, commitSha });
}
