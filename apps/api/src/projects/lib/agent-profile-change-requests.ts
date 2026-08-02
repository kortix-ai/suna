import { changeRequests } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { getNextCrNumber } from '../change-requests';
import { type GitBackedProject, getBranchDiff, resolveBranchAheadState } from '../git';

type ChangeRequestRow = typeof changeRequests.$inferSelect;

export async function findOpenAgentProfileChangeRequest(
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
    const agentProfile = metadata.agent_profile as Record<string, unknown> | undefined;
    if (agentProfile?.agent_name === agentName) return row;

    const agentConfig = metadata.agent_config as Record<string, unknown> | undefined;
    if (agentConfig?.agent_name === agentName) return row;
    const behaviorPath = agentConfig?.behavior_path;
    if (typeof behaviorPath === 'string' && pathSet.has(behaviorPath)) return row;

    if (agentProfile || agentConfig) continue;
    const diff = await getBranchDiff(projectForGit, row.baseRef, row.headRef);
    if (diff.files.some((file) => legacyConflictPaths.has(file.path))) return row;
  }
  return null;
}

export type CreateAgentProfileChangeRequestResult =
  | { ok: true; row: ChangeRequestRow }
  | { ok: false; status: 400 | 409 | 422 | 500; body: Record<string, unknown> };

function isDuplicateKey(error: unknown): boolean {
  if ((error as { code?: unknown })?.code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key/.test(message);
}

function isOpenAgentProfileDuplicate(error: unknown): boolean {
  const constraint = (error as { constraint?: unknown })?.constraint;
  if (
    constraint === 'idx_change_requests_open_agent_profile_agent' ||
    constraint === 'idx_change_requests_open_agent_config_agent'
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('idx_change_requests_open_agent_profile_agent') ||
    message.includes('idx_change_requests_open_agent_config_agent')
  );
}

export async function createAgentProfileChangeRequest(input: {
  accountId: string;
  projectId: string;
  userId: string;
  projectForGit: GitBackedProject;
  title: string;
  description?: string;
  baseRef: string;
  headRef: string;
  metadata: Record<string, unknown>;
}): Promise<CreateAgentProfileChangeRequestResult> {
  if (input.baseRef === input.headRef) {
    return {
      ok: false,
      status: 400,
      body: { error: 'head_ref and base_ref must differ' },
    };
  }

  let baseSha: string;
  let headSha: string;
  let headAhead: boolean;
  try {
    const aheadState = await resolveBranchAheadState(
      input.projectForGit,
      input.baseRef,
      input.headRef,
    );
    baseSha = aheadState.baseSha;
    headSha = aheadState.headSha;
    headAhead = aheadState.ahead;
  } catch (error) {
    return {
      ok: false,
      status: 400,
      body: {
        error: error instanceof Error ? error.message : 'Failed to resolve branches',
      },
    };
  }
  if (!headAhead) {
    return {
      ok: false,
      status: 422,
      body: {
        error: `head_ref "${input.headRef}" has no commits ahead of "${input.baseRef}" - the change request would be empty and could never be applied. Commit your work and push the branch, then retry. If your branch is behind the latest base, rebase it first.`,
        code: 'CR_HEAD_NOT_AHEAD',
      },
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const number = await getNextCrNumber(input.projectId);
    try {
      const [row] = await db
        .insert(changeRequests)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          number,
          title: input.title,
          description: input.description ?? '',
          baseRef: input.baseRef,
          headRef: input.headRef,
          headCommitSha: headSha,
          baseCommitSha: baseSha,
          originSessionId: null,
          createdBy: input.userId,
          metadata: input.metadata,
        })
        .returning();
      if (row) return { ok: true, row };
    } catch (error) {
      if (isOpenAgentProfileDuplicate(error)) {
        return {
          ok: false,
          status: 409,
          body: {
            error: 'An open change request already exists for this agent profile.',
            code: 'pending_agent_profile_change',
          },
        };
      }
      if (!isDuplicateKey(error)) throw error;
    }
  }
  return { ok: false, status: 500, body: { error: 'Failed to allocate CR number' } };
}
