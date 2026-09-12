/**
 * Resolve a project's GitHub repository identity for snapshot addressing.
 *
 * The identity prefix — provider, numeric repository id, owner, repo — is
 * resolved ONCE, at connection or preparation time, and cached on the project.
 * It is never looked up during a prepared session start: that would put a
 * GitHub API call back on the critical path this feature exists to remove.
 */
import { projectGitConnections, projects } from '@kortix/db';
import { eq, sql, type SQL } from 'drizzle-orm';
import { logger } from '../lib/logger';
import {
  getProjectGitConnection,
  getProjectGitRemote,
  resolveUpstreamUrl,
  withProjectGitAuth,
} from '../projects/lib/git';
import { metadataMergeSubtree } from '../projects/lib/metadata-merge';
import { getRepo, parseGitHubRepoUrl } from '../projects/github';
import type { ProjectGitConnectionRow, ProjectRow } from '../projects/lib/serializers';
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

/**
 * The project's git connection row, or null. A database read and nothing else.
 *
 * Every managed and connected project records its remote HERE, and
 * `getProjectGitRemote` gives this row precedence over project metadata. A
 * snapshot identity read without it saw only the metadata copy — which for a
 * managed project carries no provider and no repository id — so the whole
 * feature silently skipped the product's main project path.
 */
type Connection = ProjectGitConnectionRow | null | undefined;

function upstreamGitHubCoordinates(
  project: ProjectRow,
  connection?: Connection,
): { owner: string; repo: string } | null {
  const remote = getProjectGitRemote(project, connection);
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

/** Does this project have a git connection row? When it does, that row wins. */
const hasConnectionSql = sql`exists (
  select 1 from kortix.project_git_connections c where c.project_id = ${projects.projectId}
)`;

/**
 * The repository id `getProjectGitRemote` would read.
 *
 * Same precedence as the TypeScript: a connection row, when one exists, is the
 * whole answer — even when its repository id is empty, because the metadata copy
 * is not consulted for a connected project. Otherwise the metadata subtree in
 * effect, where `repo_id` is the legacy spelling.
 */
export const recordedRepositoryIdSql = sql`(case
  when ${hasConnectionSql}
  then (select nullif(c.external_repo_id, '') from kortix.project_git_connections c
        where c.project_id = ${projects.projectId} limit 1)
  else coalesce(
    nullif(${effectiveGitSubtreeSql} ->> 'external_repo_id', ''),
    nullif(${effectiveGitSubtreeSql} ->> 'repo_id', ''))
end)`;

/** Exactly the projects `getProjectGitRemote` reports as GitHub-backed, connection first. */
export const githubBackedProjectsSql = sql`(case
  when ${hasConnectionSql}
  then exists (select 1 from kortix.project_git_connections c
               where c.project_id = ${projects.projectId} and c.provider = 'github')
  else (${projects.metadata} -> 'git' ->> 'provider' = 'github'
        or (not (${projects.metadata} ? 'git') and ${projects.metadata} ? 'github'))
end)`;

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
export function recordedRepositoryId(project: ProjectRow, connection?: Connection): string | null {
  const remote = getProjectGitRemote(project, connection);
  const value = (remote.externalRepoId ?? '').trim();
  return /^[0-9]{1,20}$/.test(value) ? value : null;
}

/**
 * Read the identity from what is already stored. No network, no GitHub token.
 *
 * Pass the project's connection row when the caller has it. Without it this
 * sees only project metadata, which is wrong for every connected project; use
 * `loadRepoSnapshotRepository` unless the row is already in hand.
 */
export function readRepoSnapshotRepository(
  project: ProjectRow,
  connection?: Connection,
): RepoIdentityResolution {
  const remote = getProjectGitRemote(project, connection);
  if (remote.provider !== 'github') {
    return {
      repository: null,
      unsupportedReason: `provider ${remote.provider} is not GitHub`,
      githubBacked: false,
    };
  }
  const coordinates = upstreamGitHubCoordinates(project, connection);
  if (!coordinates) {
    return {
      repository: null,
      unsupportedReason: 'project has no resolvable GitHub owner/repo',
      githubBacked: true,
    };
  }
  const repositoryId = recordedRepositoryId(project, connection);
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
 * The identity from what is stored, INCLUDING the project's connection row.
 *
 * One database read, no network, no GitHub token: the variant a session-create
 * path calls.
 */
export async function loadRepoSnapshotRepository(project: ProjectRow): Promise<RepoIdentityResolution> {
  return readRepoSnapshotRepository(project, await getProjectGitConnection(project.projectId));
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
  const connection = await getProjectGitConnection(project.projectId);
  const cached = readRepoSnapshotRepository(project, connection);
  if (cached.repository || cached.unsupportedReason !== 'project has no recorded GitHub repository id') {
    return cached;
  }
  const coordinates = upstreamGitHubCoordinates(project, connection);
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
    if (connection) {
      // A connected project's remote lives on its connection row, and that row
      // shadows project metadata — so the id belongs there, where every later
      // read will look for it.
      await db
        .update(projectGitConnections)
        .set({ externalRepoId: identity.repositoryId, updatedAt: new Date() })
        .where(eq(projectGitConnections.connectionId, connection.connectionId));
    } else {
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
    }
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
  // Past the bound the names are dropped, and THAT is recorded — as the
  // generation at which it happened, not a boolean. The drain then enumerates
  // the repository's branches from the provider, which is the authoritative
  // list, instead of trusting a truncated one. Nothing accepted is lost, the hot
  // row stays bounded, and a drain cannot acknowledge an overflow raised after
  // it started reading, because the generation it acknowledges is not this one.
  const nextSeqInline = sql`(coalesce((${subtree} ->> 'snapshot_pending_seq')::bigint, 0) + 1)`;
  // Both branches are jsonb: a bigint THEN against a jsonb ELSE is a type
  // error, and silently coercing one of them would store a generation in a
  // shape the reader does not recognise.
  const overflowSeq = sql`(
    case when (select count(*) from ${union} u) > ${MAX_PENDING_REFS}
         then to_jsonb(${nextSeqInline})
         else coalesce(${subtree} -> 'snapshot_pending_overflow_seq', 'null'::jsonb)
    end
  )`;
  // A monotonic counter, bumped by every park. The drain reads it before it
  // starts and clears the overflow marker only if it has not moved — otherwise
  // a push that overflowed WHILE the drain was enumerating would have its
  // marker erased by the drain's acknowledgement of the earlier one.
  const nextSeq = sql`(coalesce((${subtree} ->> 'snapshot_pending_seq')::bigint, 0) + 1)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ${subtree} || jsonb_build_object('snapshot_pending_refs', ${merged})
               || jsonb_build_object('snapshot_pending_overflow_seq', ${overflowSeq})
               || jsonb_build_object('snapshot_pending_seq', ${nextSeq}))`;
}

/**
 * The overflow recovery state, as ONE generation-bound record.
 *
 *   seq          bumped by every park.
 *   overflowSeq  the `seq` at which a park last truncated, or null when none.
 *                Recovery is owed exactly while this is set.
 *   page         the next provider page to enumerate.
 *   pageSeq      the generation that cursor belongs to.
 *
 * The cursor is meaningless outside its generation: a later push that overflows
 * again raises a NEW `overflowSeq`, and a page counter left over from the
 * previous one would resume in the middle of a list that is no longer the one
 * being recovered. So a drain that finds `pageSeq !== overflowSeq` starts at
 * page 1, and every write back is conditional on the generation it read.
 */
export interface PendingOverflowState {
  seq: number;
  overflowSeq: number | null;
  page: number;
  pageSeq: number | null;
}

function pendingSubtree(project: ProjectRow): Record<string, unknown> {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  return (meta[gitMetadataSubtree(project)] ?? {}) as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  // `Number(null)` is 0, and a JSON null here means "no generation" — not
  // generation zero, which is a real value this state machine can hold.
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function pendingOverflowState(project: ProjectRow): PendingOverflowState {
  const subtree = pendingSubtree(project);
  const overflowSeq = numberOrNull(subtree.snapshot_pending_overflow_seq);
  const pageSeq = numberOrNull(subtree.snapshot_pending_page_seq);
  const page = numberOrNull(subtree.snapshot_pending_page);
  return {
    seq: numberOrNull(subtree.snapshot_pending_seq) ?? 0,
    overflowSeq,
    // A cursor from another generation is not a cursor for this one.
    page: page && page > 0 && pageSeq === overflowSeq ? page : 1,
    pageSeq,
  };
}

/** Is recovery owed? */
export function pendingPushedRefsOverflowed(project: ProjectRow): boolean {
  return pendingOverflowState(project).overflowSeq !== null;
}

/** The park counter this project is at; see `addPendingPushedRefsExpr`. */
export function pendingPushedSeq(project: ProjectRow): number {
  return pendingOverflowState(project).seq;
}

/** Only a project whose overflow generation is still `overflowSeq` may be written. */
export function pendingOverflowUnchanged(project: ProjectRow, overflowSeq: number): SQL {
  const key = gitMetadataSubtree(project);
  return sql`coalesce((coalesce(${projects.metadata} -> ${key}, '{}'::jsonb) ->> 'snapshot_pending_overflow_seq')::bigint, -1) = ${overflowSeq}`;
}

/** Record where a bounded enumeration got to, bound to its generation. */
export function advanceOverflowCursorExpr(project: ProjectRow, nextPage: number, overflowSeq: number): SQL {
  const key = gitMetadataSubtree(project);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ${subtree} || jsonb_build_object('snapshot_pending_page', ${Math.max(1, nextPage)}::int)
               || jsonb_build_object('snapshot_pending_page_seq', ${overflowSeq}::bigint))`;
}

/** Recovery is complete for this generation: drop the whole cursor. */
export function clearPendingOverflowExpr(project: ProjectRow): SQL {
  const key = gitMetadataSubtree(project);
  const subtree = sql`coalesce(${projects.metadata} -> ${key}, '{}'::jsonb)`;
  return sql`coalesce(${projects.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text,
    ((${subtree} - 'snapshot_pending_overflow_seq') - 'snapshot_pending_page') - 'snapshot_pending_page_seq')`;
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


export function withCommit(
  repository: RepoSnapshotRepository,
  commitSha: string,
): RepoSnapshotIdentity {
  return normalizeRepoSnapshotIdentity({ ...repository, commitSha });
}
