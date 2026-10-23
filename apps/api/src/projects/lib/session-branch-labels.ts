// A session branch is named by its session's UUID, so the Files version picker
// showed versions by UUID (KRTX-3020). The branch list now carries each
// session's title, agent and the viewer's archive, and the picker leads with
// those.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { isSessionBranchName } from '../git/branches';
import type { GitBranchInfo } from '../git/types';
import { isPlaceholderOpencodeTitle, runtimeRootTitleFromSnapshot } from './opencode-title';
import { loadSessionUserStates } from './session-user-state';

export interface BranchSessionLabel {
  /** The session's title, or null: it has none yet, or the caller may not open it. */
  title: string | null;
  agent_name: string | null;
  /** The caller archived the session. */
  archived: boolean;
  /** The session is in Recently deleted. Its branch is kept. */
  deleted: boolean;
}

export type LabelledBranch = GitBranchInfo & { session?: BranchSessionLabel };

/** The columns of a session row that its label reads. */
export interface SessionBranchRow {
  sessionId: string;
  agentName: string | null;
  runtimeSessionId: string | null;
  customName: unknown;
  name: unknown;
  snapshot: unknown;
  deleted: boolean;
}

/** `serializeSession`'s `name`: a rename, then the runtime's root title, then the generated title. */
export function sessionBranchTitle(row: SessionBranchRow): string | null {
  const customName = typeof row.customName === 'string' ? row.customName : null;
  const autoName = typeof row.name === 'string' && !isPlaceholderOpencodeTitle(row.name) ? row.name : null;
  return customName ?? runtimeRootTitleFromSnapshot(row.snapshot, row.runtimeSessionId) ?? autoName;
}

export function labelSessionBranches(
  branches: GitBranchInfo[],
  rows: SessionBranchRow[],
  viewer: { openable: ReadonlySet<string>; archived: ReadonlySet<string> },
): LabelledBranch[] {
  const bySession = new Map(rows.map((row) => [row.sessionId, row]));
  return branches.map((branch) => {
    const row = branch.is_default ? undefined : bySession.get(branch.name);
    if (!row) return branch;
    return {
      ...branch,
      session: {
        // The session list redacts the title of a session the caller may not open.
        title: viewer.openable.has(row.sessionId) ? sessionBranchTitle(row) : null,
        agent_name: row.agentName,
        archived: viewer.archived.has(row.sessionId),
        deleted: row.deleted,
      },
    };
  });
}

/** Labels the session branches of one listing. The listing is capped (`BRANCH_LIST_MAX_LIMIT`), so this is one read. */
export async function withSessionLabels(
  projectId: string,
  branches: GitBranchInfo[],
  viewer: { userId: string; openableSessionIds(ids: readonly string[]): Promise<Set<string>> },
): Promise<LabelledBranch[]> {
  const ids = branches.filter((b) => !b.is_default && isSessionBranchName(b.name)).map((b) => b.name);
  if (ids.length === 0) return branches;
  const [rows, openable, states] = await Promise.all([
    db
      .select({
        sessionId: projectSessions.sessionId,
        agentName: projectSessions.agentName,
        runtimeSessionId: projectSessions.runtimeSessionId,
        customName: sql<unknown>`${projectSessions.metadata} -> 'custom_name'`,
        name: sql<unknown>`${projectSessions.metadata} -> 'name'`,
        snapshot: sql<unknown>`${projectSessions.metadata} -> 'opencode_sessions'`,
        deleted: sql<boolean>`(${projectSessions.metadata} ? 'deletedAt') is true`,
      })
      .from(projectSessions)
      .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, ids))),
    viewer.openableSessionIds(ids),
    loadSessionUserStates(ids, viewer.userId),
  ]);
  const archived = new Set([...states].filter(([, state]) => state.archivedAt).map(([id]) => id));
  return labelSessionBranches(branches, rows, { openable, archived });
}
