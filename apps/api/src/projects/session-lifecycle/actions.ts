import { pauseComputeSession } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { withProjectGitAuth } from '../lib/git';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  buildSessionSandboxEnvVars,
  sandboxCallbackUnreachableReason,
} from '../lib/sessions';
import {
  isMissingRuntimeError,
  retireSessionSandboxRow,
} from '../routes/shared';

export async function deleteSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  userId: string;
  metadata?: Record<string, unknown> | null;
}): Promise<{ ok: true } | { error: string; status: number }> {
  const { projectId, sessionId, accountId, userId } = input;
  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
      ),
    )
    .limit(1);

  const deletedAt = new Date();
  const [row] = await db
    .update(projectSessions)
    .set({
      status: 'stopped',
      metadata: {
        ...(input.metadata ?? {}),
        deletedAt: deletedAt.toISOString(),
        deletedBy: userId,
      },
      updatedAt: deletedAt,
    })
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, accountId),
      ),
    )
    .returning();

  if (!row) return { error: 'Not found', status: 404 };

  if (sandbox) {
    await db
      .update(sessionSandboxes)
      .set({
        status: 'archived',
        metadata: {
          ...(sandbox.metadata ?? {}),
          stoppedAt: deletedAt.toISOString(),
          initStatus: sandbox.status === 'active' ? 'ready' : 'failed',
          ...(sandbox.status === 'active'
            ? {}
            : { lastInitError: 'Session was stopped before sandbox initialization completed' }),
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId))
      .catch((err) => {
        console.warn(`[projects] failed to mark session sandbox archived for ${sessionId}:`, err);
      });

    if (
      sandbox.externalId &&
      (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider)
    ) {
      const provider = getProvider(sandbox.provider as SandboxProviderName);
      void provider.remove(sandbox.externalId).catch((err) => {
        console.warn(
          `[projects] failed to remove provider sandbox ${sandbox.externalId} for deleted session ${sessionId}:`,
          err,
        );
      });
    }
  }

  void pauseComputeSession(sessionId).catch((err) =>
    console.warn(`[projects] compute pause failed for ${sessionId}:`, err),
  );

  return { ok: true };
}

export async function restartSession(input: {
  loaded: {
    row: {
      accountId: string;
      projectId: string;
      repoUrl: string;
      defaultBranch: string;
      manifestPath: string;
      metadata?: Record<string, unknown> | null;
    };
    userId: string;
  };
  session: {
    sandboxProvider: string;
    baseRef: string | null;
    agentName: string | null;
    opencodeSessionId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectId: string;
  sessionId: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { loaded, session, projectId, sessionId } = input;
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return { status: 400, body: { error: `Restart is not supported for provider ${providerName}` } };
  }

  const restartUnreachable = sandboxCallbackUnreachableReason();
  if (restartUnreachable) {
    return { status: 503, body: { error: restartUnreachable, code: 'KORTIX_URL_UNREACHABLE' } };
  }

  const [existingSandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sessionId))
    .limit(1);

  const provisionReplacementRuntime = async () => {
    const initialPrompt = session.opencodeSessionId
      ? null
      : typeof session.metadata?.initial_prompt === 'string'
        ? (session.metadata.initial_prompt as string)
        : null;
    const opencodeModel =
      typeof session.metadata?.opencode_model === 'string'
        ? (session.metadata.opencode_model as string)
        : null;

    await db
      .update(projectSessions)
      .set({
        status: 'provisioning',
        error: null,
        sandboxUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, sessionId));

    const runtimeMetadata = { restarted_at: new Date().toISOString() };
    allocateSessionRuntime({
      sessionId,
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
      project: loaded.row as any,
      providerName,
      baseRef: session.baseRef ?? loaded.row.defaultBranch,
      agentName: session.agentName ?? 'default',
      runtimeMetadata,
      sessionMetadata: { ...(session.metadata ?? {}), ...runtimeMetadata },
      buildEnvVars: () =>
        buildSessionSandboxEnvVars({
          accountId: loaded.row.accountId,
          projectId,
          sessionId,
          userId: loaded.userId,
          repoUrl: loaded.row.repoUrl,
          baseRef: session.baseRef ?? loaded.row.defaultBranch,
          agentName: session.agentName ?? 'default',
          initialPrompt,
          opencodeModel,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
        }),
      resolveGitAuthToken: async () =>
        (await withProjectGitAuth(loaded.row as any)).gitAuthToken ?? null,
    });
  };

  if (
    existingSandbox?.externalId &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(existingSandbox.provider)
  ) {
    const externalId = existingSandbox.externalId;
    const provider = getProvider(existingSandbox.provider as SandboxProviderName);
    const providerStatus = await provider.getStatus(externalId).catch(() => 'unknown' as const);
    if (providerStatus === 'removed') {
      await retireSessionSandboxRow(existingSandbox, 'restart_removed_runtime').catch((err) =>
        console.warn(
          `[projects] failed to retire removed runtime ${externalId} for session ${sessionId}:`,
          err,
        ),
      );
      await provisionReplacementRuntime();
      return {
        status: 202,
        body: { ok: true, session_id: sessionId, status: 'provisioning', reason: 'runtime_removed' },
      };
    }

    await db
      .update(sessionSandboxes)
      .set({ status: 'provisioning', updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, sessionId));
    await db
      .update(projectSessions)
      .set({
        status: 'provisioning',
        error: null,
        sandboxUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, sessionId));

    void (async () => {
      try {
        await provider.stop(externalId).catch(() => {});
        await provider.start(externalId);
        await db
          .update(sessionSandboxes)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(sessionSandboxes.sandboxId, sessionId));
        await db
          .update(projectSessions)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sessionId));
      } catch (err) {
        console.warn(`[projects] restart-in-place failed for ${sessionId}:`, err);
        if (isMissingRuntimeError(err)) {
          await retireSessionSandboxRow(existingSandbox, 'restart_missing_runtime').catch(() => {});
          await provisionReplacementRuntime().catch((allocErr) =>
            console.warn(
              `[projects] failed to reallocate missing runtime for session ${sessionId}:`,
              allocErr,
            ),
          );
          return;
        }
        await db
          .update(sessionSandboxes)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(
            and(
              eq(sessionSandboxes.sandboxId, sessionId),
              eq(sessionSandboxes.externalId, externalId),
            ),
          )
          .catch(() => {});
        await db
          .update(projectSessions)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sessionId))
          .catch(() => {});
      }
    })();

    return { status: 202, body: { ok: true, session_id: sessionId, status: 'provisioning' } };
  }

  await provisionReplacementRuntime();
  return { status: 202, body: { ok: true, session_id: sessionId, status: 'provisioning' } };
}
