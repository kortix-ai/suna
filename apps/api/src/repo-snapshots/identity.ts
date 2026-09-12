/**
 * Resolve a project's GitHub repository identity for snapshot addressing.
 *
 * The identity prefix — provider, numeric repository id, owner, repo — is
 * resolved ONCE, at connection or preparation time, and cached on the project.
 * It is never looked up during a prepared session start: that would put a
 * GitHub API call back on the critical path this feature exists to remove.
 */
import { projects } from '@kortix/db';
import { eq, sql, type SQL } from 'drizzle-orm';
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
 * Bounded, because this is metadata on a hot row. The bound is deliberately far
 * above any real push — a branch name is tens of bytes, so a thousand of them
 * is a few tens of kilobytes — and the union is computed in SQL against the
 * CURRENT value, so several pushes during one outage accumulate rather than
 * overwrite. Past the bound the oldest names by sort order are dropped and the
 * caller says so; the alternative is unbounded metadata on a row every session
 * start reads.
 */
const MAX_PENDING_REFS = 1000;

export function pendingPushedRefs(project: ProjectRow): string[] {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  const subtree = meta[gitMetadataSubtree(project)];
  const raw = subtree?.snapshot_pending_refs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
}

/**
 * ADD these branches to whatever is already parked, in SQL.
 *
 * Merging in JavaScript reads the array off the `ProjectRow` the caller was
 * handed, which is a snapshot from before the previous push wrote its own — so
 * two pushes arriving during the same outage each wrote their own list and the
 * second erased the first. The union is computed against the CURRENT row value,
 * under that row's write lock, so concurrent pushes accumulate instead of
 * overwriting.
 */
export function addPendingPushedRefsExpr(project: ProjectRow, refs: string[]): SQL {
  const key = gitMetadataSubtree(project);
  const additions = [...new Set(refs.map((ref) => ref.replace(/^refs\/heads\//, '')))].filter(Boolean);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  const union = sql`(
    select ref from (
      select jsonb_array_elements_text(
        case when jsonb_typeof(${subtree} -> 'snapshot_pending_refs') = 'array'
             then ${subtree} -> 'snapshot_pending_refs' else '[]'::jsonb end) as ref
      union
      select jsonb_array_elements_text(${JSON.stringify(additions)}::jsonb) as ref
    ) all_refs
  )`;
  const merged = sql`(
    select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb)
    from (select ref from ${union} u order by ref limit ${MAX_PENDING_REFS}) bounded
  )`;
  // Past the bound the names are dropped, and THAT is recorded: the drain then
  // re-enumerates the repository's branches from the provider, which is the
  // authoritative list, instead of trusting a truncated one. Nothing accepted is
  // lost, and the hot row stays bounded.
  const overflowed = sql`(
    (select count(*) from ${union} u) > ${MAX_PENDING_REFS}
    or coalesce((${subtree} ->> 'snapshot_pending_overflow')::boolean, false)
  )`;
  // A monotonic counter, bumped by every park. The drain reads it before it
  // starts and clears the overflow marker only if it has not moved — otherwise
  // a push that overflowed WHILE the drain was enumerating would have its
  // marker erased by the drain's acknowledgement of the earlier one.
  const nextSeq = sql`(coalesce((${subtree} ->> 'snapshot_pending_seq')::bigint, 0) + 1)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ${subtree} || jsonb_build_object('snapshot_pending_refs', ${merged})
               || jsonb_build_object('snapshot_pending_overflow', ${overflowed})
               || jsonb_build_object('snapshot_pending_seq', ${nextSeq}))`;
}

/** The park counter this project is at; see `addPendingPushedRefsExpr`. */
export function pendingPushedSeq(project: ProjectRow): number {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  const raw = meta[gitMetadataSubtree(project)]?.snapshot_pending_seq;
  return Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

/** Where a bounded enumeration got to, so the next pass resumes rather than restarts. */
export function pendingOverflowPage(project: ProjectRow): number {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  const raw = meta[gitMetadataSubtree(project)]?.snapshot_pending_page;
  const page = Number(raw);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

/** Record how far the enumeration got. */
export function setPendingOverflowPageExpr(project: ProjectRow, page: number): SQL {
  const key = gitMetadataSubtree(project);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ${subtree} || jsonb_build_object('snapshot_pending_page', ${Math.max(1, page)}::int))`;
}

/** Only a project whose park counter is still `seq` may have its marker cleared. */
export function pendingSeqUnchanged(project: ProjectRow, seq: number): SQL {
  const key = gitMetadataSubtree(project);
  return sql`coalesce((coalesce(${projects.metadata} -> ${key}, '{}'::jsonb) ->> 'snapshot_pending_seq')::bigint, 0) = ${seq}`;
}

/** Did a push park more branches than the bound allows? */
export function pendingPushedRefsOverflowed(project: ProjectRow): boolean {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  return meta[gitMetadataSubtree(project)]?.snapshot_pending_overflow === true;
}

/**
 * REMOVE exactly these branches from the parked list, in SQL.
 *
 * Clearing the whole key would drop branches a push parked while these were
 * being scheduled, and would also clear on a partial success.
 */
export function removePendingPushedRefsExpr(project: ProjectRow, refs: string[]): SQL {
  const key = gitMetadataSubtree(project);
  const removals = [...new Set(refs.map((ref) => ref.replace(/^refs\/heads\//, '')))].filter(Boolean);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  const remaining = sql`(
    select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb)
    from (
      select jsonb_array_elements_text(
        case when jsonb_typeof(${subtree} -> 'snapshot_pending_refs') = 'array'
             then ${subtree} -> 'snapshot_pending_refs' else '[]'::jsonb end) as ref
    ) parked
    where ref <> all (array(select jsonb_array_elements_text(${JSON.stringify(removals)}::jsonb)))
  )`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ${subtree} || jsonb_build_object('snapshot_pending_refs', ${remaining}))`;
}

/** Clear the overflow marker, once the authoritative enumeration has run. */
export function clearPendingOverflowExpr(project: ProjectRow): SQL {
  const key = gitMetadataSubtree(project);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    (${subtree} - 'snapshot_pending_overflow') - 'snapshot_pending_page')`;
}

export function withCommit(
  repository: RepoSnapshotRepository,
  commitSha: string,
): RepoSnapshotIdentity {
  return normalizeRepoSnapshotIdentity({ ...repository, commitSha });
}
