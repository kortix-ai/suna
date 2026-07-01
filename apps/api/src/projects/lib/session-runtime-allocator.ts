import type { Effect } from 'effect';
import { eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { readProjectWarmPointer } from '../../snapshots/warm-project';
import { sharedDb as db } from '../../shared/effect';
import type { SandboxProviderName } from '../../shared/effect';
import type { ProjectRow } from './serializers';

type RuntimeProject = Pick<ProjectRow, 'repoUrl' | 'defaultBranch' | 'manifestPath' | 'metadata'>;

export interface AllocateSessionRuntimeInput {
  sessionId: string;
  accountId: string;
  projectId: string;
  userId: string;
  project: RuntimeProject;
  providerName: SandboxProviderName;
  baseRef: string;
  agentName: string;
  sandboxSlug?: string;
  sessionMetadata: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  buildEnvVars: () => Promise<Record<string, string>>;
  resolveGitAuthToken: () => Promise<string | null>;
  beforeActive?: (externalId: string) => Promise<void>;
}

/**
 * Allocate compute for an already-created project session.
 *
 * `createProjectSession` owns durable identity (`project_sessions.session_id`,
 * git branch, visible metadata). This allocator only attaches runtime capacity
 * for that exact id.
 */
export function allocateSessionRuntime(input: AllocateSessionRuntimeInput): void {
  void allocateSessionRuntimeAsync(input);
}

async function allocateSessionRuntimeAsync(input: AllocateSessionRuntimeInput): Promise<void> {
  const tl = new ProvisionTimeline(input.sessionId, 'session-create');
  try {
    const gitAuthPromise = input.resolveGitAuthToken().then((token) => {
      tl.mark('git-auth');
      return token;
    });
    const envPromise = input.buildEnvVars().then((envVars) => {
      tl.mark('env-vars');
      return envVars;
    });

    const extraEnvVars = {
      ...(await envPromise),
      ...(input.extraEnvVars ?? {}),
    };

    await provisionSessionSandbox({
      sandboxId: input.sessionId,
      accountId: input.accountId,
      projectId: input.projectId,
      userId: input.userId,
      agentName: input.agentName,
      provider: input.providerName,
      metadata: {
        session_id: input.sessionId,
        project_id: input.projectId,
        ...(input.runtimeMetadata ?? {}),
      },
      extraEnvVars,
      projectMetadata: input.project.metadata,
      gitProject: {
        projectId: input.projectId,
        repoUrl: input.project.repoUrl,
        defaultBranch: input.project.defaultBranch,
        manifestPath: input.project.manifestPath,
        gitAuthToken: null,
      },
      resolveGitAuthToken: async () => gitAuthPromise,
      baseRef: input.baseRef,
      sandboxSlug: input.sandboxSlug,
      projectWarmSnapshot: (() => {
        const p = readProjectWarmPointer(input.project.metadata);
        return p ? { name: p.name, provider: p.provider } : null;
      })(),
      beforeActive: input.beforeActive,
    });

    tl.mark('kicked');
    const sessionStartTimeline = tl.log();
    void mergeSessionMetadata(input.sessionId, {
      session_start_timeline: sessionStartTimeline,
    }).catch(() => {});
  } catch (err) {
    const message = (err as Error)?.message || 'Sandbox provisioning failed';
    console.error(`[projects] Failed to allocate runtime for session ${input.sessionId}:`, err);
    try {
      await db
        .update(projectSessions)
        .set({
          status: 'failed',
          error: message,
          metadata: { ...input.sessionMetadata, provisioning_error: message },
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.sessionId, input.sessionId));
    } catch (markErr) {
      console.error(`[projects] Failed to mark session ${input.sessionId} failed:`, markErr);
    }
  }
}

async function mergeSessionMetadata(
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const [current] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const currentMetadata =
    current?.metadata && typeof current.metadata === 'object'
      ? (current.metadata as Record<string, unknown>)
      : {};
  await db
    .update(projectSessions)
    .set({
      metadata: { ...currentMetadata, ...extra },
      updatedAt: new Date(),
    })
    .where(eq(projectSessions.sessionId, sessionId));
}
