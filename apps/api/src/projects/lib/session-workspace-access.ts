import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { PROJECT_ACTIONS } from '../../iam/actions';
import { db } from '../../shared/db';
import {
  workspaceModeAllowsFullRepository,
  workspaceModeFromSessionMetadata,
} from './session-sandbox-metadata';

const REPOSITORY_ACTIONS = new Set<string>([
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_FILE_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
  PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
]);

export function isRepositoryProjectAction(action: string): boolean {
  return REPOSITORY_ACTIONS.has(action);
}

export function workspaceMetadataAllowsRepositoryAccess(metadata: unknown): boolean {
  return workspaceModeAllowsFullRepository(workspaceModeFromSessionMetadata(metadata));
}

export async function sessionWorkspaceAllowsRepositoryAccess(input: {
  sessionId: string;
  accountId: string;
  projectId: string;
}): Promise<boolean> {
  const [session] = await db
    .select({ sessionMetadata: projectSessions.metadata })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.accountId, input.accountId),
        eq(projectSessions.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!session) return false;
  return workspaceMetadataAllowsRepositoryAccess(session.sessionMetadata);
}
