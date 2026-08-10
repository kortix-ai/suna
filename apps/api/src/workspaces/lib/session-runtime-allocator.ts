import { eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import type { SandboxProviderName } from '../../config';
import { logger } from '../../lib/logger';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { db } from '../../shared/db';
import type { GitBackedWorkspace } from '../git';
import { RuntimeIdentityConflictError } from '../runtime-identity-error';
import type { WorkspaceRow } from './serializers';
import { workspaceSessionMetadataMerge } from './session-metadata-merge';
import { mergeSessionSandboxEnv } from './session-runtime-context';

type RuntimeWorkspace = Pick<WorkspaceRow, 'repoUrl' | 'defaultBranch' | 'manifestPath' | 'metadata'>;

export interface AllocateSessionRuntimeInput {
  sessionId: string;
  accountId: string;
  workspaceId: string;
  userId: string;
  workspace: RuntimeWorkspace;
  providerName: SandboxProviderName;
  baseRef: string;
  agentName: string;
  sandboxSlug?: string;
  sessionMetadata: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  buildEnvVars: () => Promise<Record<string, string>>;
  resolveGitWorkspace: () => Promise<GitBackedWorkspace>;
  beforeActive?: (externalId: string) => Promise<void>;
}

/**
 * Allocate compute for an already-created workspace session.
 *
 * `createWorkspaceSession` owns durable identity (`project_sessions.session_id`,
 * git branch, visible metadata). This allocator only attaches runtime capacity
 * for that exact id.
 */
export function allocateSessionRuntime(input: AllocateSessionRuntimeInput): void {
  void allocateSessionRuntimeAsync(input);
}

async function allocateSessionRuntimeAsync(input: AllocateSessionRuntimeInput): Promise<void> {
  const tl = new ProvisionTimeline(input.sessionId, 'session-create');
  try {
    const gitWorkspacePromise = input.resolveGitWorkspace().then((workspace) => {
      tl.mark('git-auth');
      return workspace;
    });
    const envPromise = input.buildEnvVars().then((envVars) => {
      tl.mark('env-vars');
      return envVars;
    });

    const extraEnvVars = mergeSessionSandboxEnv(await envPromise, input.extraEnvVars);

    await provisionSessionSandbox({
      sandboxId: input.sessionId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentName: input.agentName,
      provider: input.providerName,
      metadata: {
        session_id: input.sessionId,
        workspace_id: input.workspaceId,
        ...(input.runtimeMetadata ?? {}),
      },
      extraEnvVars,
      workspaceMetadata: input.workspace.metadata,
      gitWorkspace: {
        workspaceId: input.workspaceId,
        repoUrl: input.workspace.repoUrl,
        defaultBranch: input.workspace.defaultBranch,
        manifestPath: input.workspace.manifestPath,
        gitAuthToken: null,
      },
      resolveGitWorkspace: async () => gitWorkspacePromise,
      baseRef: input.baseRef,
      sandboxSlug: input.sandboxSlug,
      beforeActive: input.beforeActive,
    });

    tl.mark('kicked');
    const sessionStartTimeline = tl.log();
    void mergeSessionMetadata(input.sessionId, {
      session_start_timeline: sessionStartTimeline,
    }).catch(() => {});
  } catch (err) {
    if (err instanceof RuntimeIdentityConflictError) {
      console.warn(`[runtime-identity] refused duplicate allocation for ${input.sessionId}`);
      return;
    }
    const message = (err as Error)?.message || 'Sandbox provisioning failed';
    // This runs detached from any request (allocateSessionRuntime is
    // fire-and-forget — restart/create already 202'd) — a structured error is
    // the ONLY signal this session is now failed with no session_sandboxes row
    // behind it, so every later proxy call will 404 'sandbox not found'.
    logger.error('[workspaces] runtime allocation failed — session marked failed', {
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      account_id: input.accountId,
      provider: input.providerName,
      error: message,
    });
    try {
      await db
        .update(projectSessions)
        .set({
          status: 'failed',
          error: message,
          // Merge, never re-write `input.sessionMetadata`: that snapshot was
          // taken before allocation started, so writing it back drops anything
          // committed since — the generated title, remote_branch,
          // the start timeline. The session is terminal here, so nothing retries.
          metadata: workspaceSessionMetadataMerge({ provisioning_error: message }),
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.sessionId, input.sessionId));
    } catch (markErr) {
      console.error(`[workspaces] Failed to mark session ${input.sessionId} failed:`, markErr);
    }
  }
}

async function mergeSessionMetadata(
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projectSessions)
    .set({
      metadata: workspaceSessionMetadataMerge(extra),
      updatedAt: new Date(),
    })
    .where(eq(projectSessions.sessionId, sessionId));
}
