import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { WORKSPACE_ACTIONS } from '../../iam/actions';
import { db } from '../../shared/db';
import {
  workspaceModeAllowsFullRepository,
  workspaceModeFromSessionMetadata,
} from './session-sandbox-metadata';

const REPOSITORY_ACTIONS = new Set<string>([
  WORKSPACE_ACTIONS.WORKSPACE_FILE_READ,
  WORKSPACE_ACTIONS.WORKSPACE_FILE_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE,
]);

export function isRepositoryWorkspaceAction(action: string): boolean {
  return REPOSITORY_ACTIONS.has(action);
}

export function workspaceMetadataAllowsRepositoryAccess(metadata: unknown): boolean {
  return workspaceModeAllowsFullRepository(workspaceModeFromSessionMetadata(metadata));
}

export async function sessionWorkspaceAllowsRepositoryAccess(input: {
  sessionId: string;
  accountId: string;
  workspaceId: string;
}): Promise<boolean> {
  const [session] = await db
    .select({ sessionMetadata: projectSessions.metadata })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.accountId, input.accountId),
        eq(projectSessions.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!session) return false;
  return workspaceMetadataAllowsRepositoryAccess(session.sessionMetadata);
}
