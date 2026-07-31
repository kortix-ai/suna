import { changeRequests } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ChangeRequestRow } from '../change-requests';
import { getBranchDiff, type GitBackedProject } from '../git';

export async function findOpenAgentConfigChangeRequest(
  projectForGit: GitBackedProject,
  projectId: string,
  agentName: string,
  paths: readonly string[],
): Promise<ChangeRequestRow | null> {
  const candidates = await db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.status, 'open')))
    .orderBy(desc(changeRequests.updatedAt));
  const pathSet = new Set(paths);
  const legacyConflictPaths = new Set(
    paths.filter((path) => !/(^|\/)kortix\.(yaml|toml)$/.test(path)),
  );
  for (const row of candidates) {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    const agentConfig = metadata.agent_config as Record<string, unknown> | undefined;
    if (agentConfig?.agent_name === agentName) return row;
    const behaviorPath = agentConfig?.behavior_path;
    if (typeof behaviorPath === 'string' && pathSet.has(behaviorPath)) return row;

    if (agentConfig) continue;
    const diff = await getBranchDiff(projectForGit, row.baseRef, row.headRef);
    if (diff.files.some((file) => legacyConflictPaths.has(file.path))) return row;
  }
  return null;
}
