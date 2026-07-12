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
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import {
  isMissingRuntimeError,
} from '../routes/shared';
import {
  retireConfirmedMissingRuntime,
  retireUnmaterializedRuntime,
} from '../runtime-identity';

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
    const runtimeModel =
      typeof session.metadata?.model === 'string'
        ? (session.metadata.model as string)
        : typeof session.metadata?.opencode_model === 'string'
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
          runtimeModel,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
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
      const retired = await retireConfirmedMissingRuntime(
        existingSandbox,
        'restart_removed_runtime',
      );
      if (retired) await provisionReplacementRuntime();
      return {
        status: 202,
        body: {
          ok: true,
          session_id: sessionId,
          status: 'provisioning',
          reason: retired ? 'runtime_recovery_provisioning' : 'runtime_recovery_in_progress',
        },
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
        // A provider may acknowledge start before discovering that the backing
        // runtime is gone (observed live with Platinum: POST start succeeded,
        // the next GET returned removed). Never mark the DB running from command
        // acceptance alone; verify provider truth first.
        let verifiedStatus = await provider.getStatus(externalId).catch(() => 'unknown' as const);
        for (let attempt = 1; verifiedStatus !== 'running' && verifiedStatus !== 'removed' && attempt < 15; attempt += 1) {
          await Bun.sleep(1_000);
          verifiedStatus = await provider.getStatus(externalId).catch(() => 'unknown' as const);
        }
        if (verifiedStatus === 'removed') {
          const retired = await retireConfirmedMissingRuntime(
            existingSandbox,
            'restart_post_start_removed',
          ).catch(() => false);
          if (retired) await provisionReplacementRuntime();
          return;
        }
        if (verifiedStatus !== 'running') {
          throw new Error(
            `Sandbox ${externalId} did not reach running after restart (provider status: ${verifiedStatus})`,
          );
        }
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
          const retired = await retireConfirmedMissingRuntime(
            existingSandbox,
            'restart_missing_runtime',
          ).catch(() => false);
          if (retired) await provisionReplacementRuntime();
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

  if (existingSandbox) {
    // Row exists but never reached a real provider sandbox (e.g. the original
    // provision failed before an externalId was assigned) — there's nothing to
    // stop/start, and leaving it in place would collide with the fresh insert
    // provisionReplacementRuntime() is about to do on the same sandboxId PK.
    await retireUnmaterializedRuntime(existingSandbox, 'restart_never_provisioned').catch((err) =>
      console.warn(
        `[projects] failed to retire never-provisioned sandbox row for session ${sessionId}:`,
        err,
      ),
    );
  }

  await provisionReplacementRuntime();
  return { status: 202, body: { ok: true, session_id: sessionId, status: 'provisioning' } };
}
