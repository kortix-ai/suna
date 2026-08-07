import {
  connectorCalls,
  projectSessions,
  projects,
  serviceAccounts,
  sessionLifecycleCommands,
} from "@kortix/db";
import { and, eq } from "drizzle-orm";
import { bindChatThread } from "../../channels/slack/binding";
import { config } from "../../config";
import { mayRequeueFailedCreate } from "./requeue-policy";
import { forwardToSandbox } from "../../sandbox-proxy/routes/preview";
import { resolveSandboxIngress } from "../../sandbox-proxy/backend";
import { serviceKeyForExternalId } from "../../platform/service-key";
import type { ProviderName } from "../../platform/providers";
import { db } from "../../shared/db";
import { getProjectTaskWorkerBinding } from "../generated-state-store";
import {
  projectTaskWorkerPromptAdmission,
  taskWorkerPromptIsAllowed,
} from "../task-worker-prompt-admission";
import { connectorBindingPayloadConflicts } from "../lib/session-connector-bindings";
import { secretsAllowlistPayloadConflicts } from "../secrets";
import {
  requireConnectorsConflicts,
  runtimeContextConflicts,
} from "./idempotency-conflicts";
import { createProjectSession } from "../lib/sessions";
import { syncSandboxEnvForPrompt } from "../lib/sandbox-env-sync";
import { allocateRuntimeOnOpen, openSession } from "../routes/shared";
import { generateSessionTitleFromFirstPrompt } from "../session-title-generate";
import { resolveProjectAutomationActor } from "./actor";
import { awaitTerminalStage } from "./await-stage";
import { stopSession } from "./stop";
import { classifyStopCommandResult } from "./stop-command-outcome";
import { sessionBackpressureState } from "./backpressure";
import { type DeliveryTarget, deliverWithRetry } from "./deliver";
import {
  LIFECYCLE_COMMAND_HEARTBEAT_MS,
  type LifecycleCommandClaim,
  type SessionLifecycleCommandRow,
  claimCreateSessionCommand,
  claimDueLifecycleCommands,
  deferLifecycleCommand,
  enqueueContinueSessionCommand,
  lifecycleCommandClaim,
  markCommandFailed,
  markCommandQueued,
  markCommandSucceeded,
  renewLifecycleCommandLease,
  repairLegacyLifecycleMessageIds,
  resultFromExistingCommand,
} from "./store";
import type { QueuedContinueSessionPayload } from "./store";
import { crossAccountIdempotencyResult } from "./idempotency-guard";
import type {
  ContinueSessionCommand,
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionDeliveryOutcome,
  SessionInvocationSource,
  SessionLifecyclePostCreateAction,
  SessionLifecycleResult,
  StartSessionCommand,
} from "./types";
import { openCodePromptPayload } from "./opencode-message-id";

const WORKSPACE = "/workspace";
const DAEMON_PORT = 8000;
const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startLifecycleCommandHeartbeat(row: SessionLifecycleCommandRow): {
  claim: LifecycleCommandClaim;
  stop: () => void;
} {
  const claim = lifecycleCommandClaim(row);
  const timer = setInterval(() => {
    void renewLifecycleCommandLease(row.commandId, claim)
      .then((renewed) => {
        if (!renewed) clearInterval(timer);
      })
      .catch((error) => {
        // A transient DB failure must not crash the executor. If the lease expires
        // and another worker reclaims the row, the claim fence rejects this
        // executor's final update.
        console.warn("[session-lifecycle] command lease heartbeat failed", {
          commandId: row.commandId,
          lockedBy: claim.lockedBy,
          attempt: claim.attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, LIFECYCLE_COMMAND_HEARTBEAT_MS);
  timer.unref?.();
  return { claim, stop: () => clearInterval(timer) };
}

function terminalTaskWorkerSessionResult(
  sessionId: string,
  taskId: string,
  action: "revive" | "create_child",
): SessionLifecycleResult {
  return {
    status: "failed",
    sessionId,
    retryable: false,
    error: {
      status: action === "create_child" ? 403 : 409,
      body: {
        error:
          action === "create_child"
            ? "Bound task workers cannot create child sessions"
            : "A terminal task worker cannot be revived",
        code: "TASK_WORKER_CONFINED",
        task_id: taskId,
      },
    },
  };
}

async function taskWorkerCreateConfinement(
  callerSessionId: string | null | undefined,
): Promise<SessionLifecycleResult | null> {
  if (!callerSessionId) return null;
  const binding = await getProjectTaskWorkerBinding(db, callerSessionId);
  return binding
    ? terminalTaskWorkerSessionResult(
        callerSessionId,
        binding.taskId,
        "create_child",
      )
    : null;
}

export async function createSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
  const confinement = await taskWorkerCreateConfinement(
    command.callerSessionId,
  );
  if (confinement) return confinement;
  const queuePolicy = command.queuePolicy ?? "never";
  const backpressure =
    queuePolicy === "never"
      ? null
      : await sessionBackpressureState(
          command.project.accountId,
          command.project.projectId,
        );
  const shouldQueue =
    queuePolicy === "always" ||
    (queuePolicy === "on_backpressure" && backpressure?.shouldQueue);
  const reason = shouldQueue
    ? (backpressure?.reason ?? "queued by policy")
    : null;

  if (!command.idempotencyKey && !shouldQueue) {
    const result = await executeCreateSession(command);
    if (result.status === "created" && result.sessionId) {
      const postCreate = await applyPostCreateActions({
        projectId: command.project.projectId,
        sessionId: result.sessionId,
        actions: command.postCreate,
      });
      if (!postCreate.ok) {
        return {
          status: "failed",
          sessionId: result.sessionId,
          row: result.row,
          retryable: false,
          error: { status: 500, body: { error: postCreate.error } },
        };
      }
    }
    return result;
  }

  const claimed = await claimCreateSessionCommand(command, {
    initialStatus: shouldQueue ? "queued" : "running",
    reason,
  });
  if (claimed.existing) {
    // Cross-tenant guard: a colliding idempotency key that is not the caller's
    // OWN create_session for this account+project must never return the foreign
    // command/session — see crossAccountIdempotencyResult.
    const crossAccount = crossAccountIdempotencyResult(
      {
        accountId: claimed.row.accountId,
        projectId: claimed.row.projectId,
        commandType: claimed.row.commandType,
      },
      {
        accountId: command.project.accountId,
        projectId: command.project.projectId,
      },
    );
    if (crossAccount) return crossAccount;
    const existingPayload = (claimed.row.payload ?? {}) as Record<
      string,
      unknown
    >;
    const existingBody =
      existingPayload.body && typeof existingPayload.body === "object"
        ? (existingPayload.body as Record<string, unknown>)
        : {};
    if (
      connectorBindingPayloadConflicts(
        existingBody.connector_bindings,
        command.body.connector_bindings,
      )
    ) {
      return {
        status: "failed",
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error:
              "Idempotency key was already used with different connector bindings",
            code: "IDEMPOTENCY_BINDING_CONFLICT",
          },
        },
      };
    }
    if (
      secretsAllowlistPayloadConflicts(
        existingBody.secrets as string[] | null | undefined,
        command.body.secrets as string[] | null | undefined,
      )
    ) {
      return {
        status: "failed",
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error:
              "Idempotency key was already used with a different secrets allowlist",
            code: "IDEMPOTENCY_SECRETS_CONFLICT",
          },
        },
      };
    }
    if (
      runtimeContextConflicts(
        existingBody.runtime_context,
        command.body.runtime_context,
      )
    ) {
      return {
        status: "failed",
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error:
              "Idempotency key was already used with a different runtime_context",
            code: "IDEMPOTENCY_CONTEXT_CONFLICT",
          },
        },
      };
    }
    // require_connectors resolves to member bindings at create; a replay with a
    // different required set would otherwise return the first session, which was
    // resolved against a different set of the user's own connections.
    if (
      requireConnectorsConflicts(
        existingBody.require_connectors,
        command.body.require_connectors,
      )
    ) {
      return {
        status: "failed",
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error:
              "Idempotency key was already used with a different require_connectors",
            code: "IDEMPOTENCY_REQUIRE_CONNECTORS_CONFLICT",
          },
        },
      };
    }
    const existingResult = resultFromExistingCommand(claimed.row);
    if (existingResult.sessionId) {
      const [row] = await db
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, existingResult.sessionId))
        .limit(1);
      if (row) {
        // A soft-deleted session is gone — deleteSession() stamps
        // metadata.deletedAt and leaves status 'stopped'. Handing the tombstone
        // back as a create "success" poisons the key forever (every follow-up
        // continueSession → no-session). Treat it as spent: 409, use a new key.
        const rowMeta = (row.metadata ?? {}) as Record<string, unknown>;
        if (typeof rowMeta.deletedAt === "string") {
          return {
            status: "failed",
            commandId: claimed.row.commandId,
            retryable: false,
            error: {
              status: 409,
              body: {
                error:
                  "Idempotency key maps to a deleted session — use a new key",
                code: "IDEMPOTENCY_KEY_SESSION_DELETED",
              },
            },
          };
        }
        existingResult.row = row;
      }
    }
    return existingResult;
  }
  if (shouldQueue) {
    await markCommandQueued(claimed.row.commandId, reason);
    return {
      status: "queued",
      commandId: claimed.row.commandId,
      retryable: true,
      reason: reason ?? undefined,
    };
  }

  const result = await executeCreateSession(command);
  if (result.status === "created" && result.sessionId) {
    const postCreate = await applyPostCreateActions({
      projectId: command.project.projectId,
      sessionId: result.sessionId,
      actions: command.postCreate,
    });
    if (!postCreate.ok) {
      await markCommandFailed(claimed.row.commandId, postCreate.error, {
        retryable: true,
        attempts: claimed.row.attempts + 1,
        sessionId: result.sessionId,
        result: {
          status: "created",
          session_id: result.sessionId,
          source: command.source,
          post_create_error: postCreate.error,
        },
      });
      return {
        status: "failed",
        commandId: claimed.row.commandId,
        sessionId: result.sessionId,
        row: result.row,
        retryable: true,
        error: { status: 500, body: { error: postCreate.error } },
      };
    }
    await markCommandSucceeded(
      claimed.row.commandId,
      {
        status: "created",
        session_id: result.sessionId,
        source: command.source,
      },
      result.sessionId,
    );
    return { ...result, commandId: claimed.row.commandId };
  }

  const message = String(
    result.error?.body?.error ?? result.reason ?? "Failed to create session",
  );
  // This is the INLINE path — the queued branch returned above — so `result` is
  // about to be handed to a waiting caller. Marking it retryable would leave the
  // command row queued for the drainer as well, and the caller (told by the
  // guide that a 429/503 is worth retrying) retries with a fresh key: two billed
  // sandboxes for one intent, both running initial_prompt.
  await markCommandFailed(claimed.row.commandId, message, {
    retryable: mayRequeueFailedCreate({
      answeredSynchronously: true,
      errorIsRetryable: result.retryable ?? false,
    }),
    attempts: claimed.row.attempts + 1,
  });
  return { ...result, commandId: claimed.row.commandId };
}

export async function startSession(
  command: StartSessionCommand,
): Promise<SessionLifecycleResult> {
  const binding = await getProjectTaskWorkerBinding(db, command.sessionId);
  if (binding?.status !== undefined && binding.status !== "doing") {
    return terminalTaskWorkerSessionResult(
      command.sessionId,
      binding.taskId,
      "revive",
    );
  }
  const first = await openSession({
    loaded: command.loaded,
    visible: command.visible,
    projectId: command.projectId,
    sessionId: command.sessionId,
  });
  // Optional long-poll: re-resolve (re-reading the live session row each tick,
  // like continueSession) until ready/terminal or the bounded deadline, so the
  // client learns `ready` immediately instead of on its ~800ms poll tick.
  // waitMs<=0 or an already-terminal first result → returns `first` unchanged,
  // so the immediate-ready path and every non-long-poll caller are untouched.
  const start = await awaitTerminalStage(
    first,
    async () => {
      const [fresh] = await db
        .select({
          status: projectSessions.status,
          sandboxProvider: projectSessions.sandboxProvider,
          baseRef: projectSessions.baseRef,
          agentName: projectSessions.agentName,
          opencodeSessionId: projectSessions.opencodeSessionId,
          accountId: projectSessions.accountId,
          metadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, command.sessionId))
        .limit(1);
      if (!fresh) return null;
      return openSession({
        loaded: command.loaded,
        visible: { row: fresh },
        projectId: command.projectId,
        sessionId: command.sessionId,
      });
    },
    { waitMs: command.waitMs ?? 0 },
  );
  return {
    status: start.stage === "ready" ? "ready" : "pending",
    sessionId: command.sessionId,
    start,
    retryable: start.retriable,
  } satisfies SessionLifecycleResult;
}

export async function continueSession(
  command: ContinueSessionCommand,
): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = command;
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  if (!session) return "no-session";
  const workerAdmission = await projectTaskWorkerPromptAdmission(db, sessionId);
  if (!taskWorkerPromptIsAllowed(workerAdmission)) return "failed";
  if (session.status === "failed") return "failed";
  // deleteSession() stamps metadata.deletedAt and leaves the row 'stopped' —
  // the same status a normal hibernate uses. Without this check a queued
  // follow-up (Slack reply, scheduled trigger, etc.) would revive a session
  // the user explicitly deleted.
  const sessionMeta = (session.metadata ?? {}) as Record<string, unknown>;
  if (typeof sessionMeta.deletedAt === "string") return "no-session";
  const userId =
    command.userId ?? (await resolveProjectAutomationActor(session.accountId));
  if (!userId) {
    console.warn("[session-lifecycle] no actor for follow-up delivery", {
      sessionId,
    });
    return "pending";
  }

  // Server-side delivery is the first prompt for sessions created without one.
  void generateSessionTitleFromFirstPrompt({
    sessionId,
    projectId: session.projectId,
    accountId: session.accountId,
    userId,
    firstPromptText: text,
  });

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return "no-session";

  if (session.status === "stopped" || session.status === "completed") {
    await db
      .update(projectSessions)
      .set({ status: "running", error: null, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, sessionId));
  }

  const loaded = { row: project, userId };
  const openOnce = async () => {
    const [fresh] = await db
      .select({
        status: projectSessions.status,
        sandboxProvider: projectSessions.sandboxProvider,
        baseRef: projectSessions.baseRef,
        agentName: projectSessions.agentName,
        opencodeSessionId: projectSessions.opencodeSessionId,
        accountId: projectSessions.accountId,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!fresh) return null;
    return openSession({
      loaded,
      visible: { row: fresh },
      projectId: session.projectId,
      sessionId,
    });
  };

  const deadline = Date.now() + READY_DEADLINE_MS;
  let opened: Awaited<ReturnType<typeof openOnce>>;
  for (;;) {
    opened = await openOnce();
    if (!opened) return "no-session";
    if (opened.stage === "ready") break;
    if (opened.stage === "failed" || opened.stage === "stopped")
      return "failed";
    if (Date.now() >= deadline) {
      console.warn(
        "[session-lifecycle] runtime not ready before delivery deadline",
        {
          sessionId,
          stage: opened.stage,
        },
      );
      return "pending";
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (command.opencodeEnv) {
    const sandbox = opened.sandbox as {
      external_id?: string | null;
      provider?: string | null;
    } | null;
    const externalId = sandbox?.external_id ?? null;
    const providerName = sandbox?.provider ?? null;
    if (!externalId || !isProviderName(providerName)) {
      console.warn(
        "[session-lifecycle] runtime env sync target is incomplete",
        {
          sessionId,
          hasExternalId: !!externalId,
          provider: providerName,
        },
      );
      return "pending";
    }
    try {
      const [serviceKey, ingress] = await Promise.all([
        serviceKeyForExternalId(externalId),
        resolveSandboxIngress(externalId, {
          port: DAEMON_PORT,
          transport: "http",
        }),
      ]);
      if (!serviceKey) throw new Error("sandbox service key is unavailable");
      await syncSandboxEnvForPrompt({
        projectId: session.projectId,
        sessionId,
        serviceKey,
        previewUrl: ingress.url,
        providerHeaders: ingress.headers,
        providerName,
        opencodeEnv: command.opencodeEnv,
      });
    } catch (err) {
      console.warn(
        "[session-lifecycle] runtime env sync failed before prompt delivery",
        {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return "pending";
    }
  }

  // Runtime is ready — hand off the prompt, healing + retrying through the
  // transient failures a freshly-woken sandbox throws (rotated opencode session
  // 404, daemon 5xx while it binds, externalId/opencode_session_id briefly
  // null). Bounce to 'pending' only after the bounded window genuinely exhausts;
  // the old code gave up on the first hiccup and dropped the user's message.
  const toTarget = (
    o: NonNullable<Awaited<ReturnType<typeof openOnce>>>,
  ): DeliveryTarget => ({
    stage: o.stage,
    externalId: sandboxExternalId(o),
    opencodeSessionId: o.opencode_session_id,
  });

  return deliverWithRetry({
    sessionId,
    opened: toTarget(opened),
    reopen: async () => {
      const healed = await openOnce();
      return healed ? toTarget(healed) : null;
    },
    send: async (externalId, runtimeId) => {
      // The task may become terminal, or an unbound child may race registration,
      // while the sandbox wakes. Re-check at the final prompt-dispatch boundary.
      const freshAdmission = await projectTaskWorkerPromptAdmission(db, sessionId);
      if (!taskWorkerPromptIsAllowed(freshAdmission)) return false;
      return postPrompt(
        externalId,
        runtimeId,
        text,
        userId,
        sessionId,
        command.messageId,
      );
    },
  });
}

export async function drainSessionLifecycleQueue(
  input: {
    workerId?: string;
    limit?: number;
    /** Drain one freshly-enqueued callback without waiting behind older work. */
    idempotencyKey?: string;
    /** Only drain commands due before this instant — see claimDueLifecycleCommands. */
    availableBefore?: Date;
  } = {},
): Promise<{
  claimed: number;
  succeeded: number;
  failed: number;
  queued: number;
}> {
  const workerId =
    input.workerId ?? `session-lifecycle:${process.pid}:${Date.now()}`;
  const repairedLegacyMessageIds = await repairLegacyLifecycleMessageIds();
  if (repairedLegacyMessageIds > 0) {
    console.warn("[session-lifecycle] repaired legacy OpenCode message IDs", {
      commands: repairedLegacyMessageIds,
    });
  }
  const rows = await claimDueLifecycleCommands({
    workerId,
    limit: input.limit ?? 10,
    idempotencyKey: input.idempotencyKey,
    availableBefore: input.availableBefore,
  });
  const out = { claimed: rows.length, succeeded: 0, failed: 0, queued: 0 };
  for (const row of rows) {
    const { claim, stop } = startLifecycleCommandHeartbeat(row);
    try {
      if (row.commandType === "provision_session") {
        const outcome = await executeQueuedProvision(row, claim);
        if (outcome !== "stale") out[outcome] += 1;
        continue;
      }
      if (row.commandType === "continue_session") {
        const outcome = await executeQueuedContinue(row, claim);
        if (outcome !== "stale") out[outcome] += 1;
        continue;
      }
      if (row.commandType === "stop_session") {
        const outcome = await executeQueuedStop(row, claim);
        if (outcome !== "stale") out[outcome] += 1;
        continue;
      }
      if (row.commandType !== "create_session") {
        const applied = await markCommandFailed(
          row.commandId,
          `Unsupported command type: ${row.commandType}`,
          { retryable: false, attempts: row.attempts, claim },
        );
        if (applied) out.failed += 1;
        continue;
      }
      const result = await executeQueuedCreate(row);
      if (result.status === "created" && result.sessionId) {
        const payload = row.payload as unknown as QueuedCreateSessionPayload;
        const postCreate = await applyPostCreateActions({
          projectId: row.projectId,
          sessionId: result.sessionId,
          actions: payload.postCreate,
        });
        if (!postCreate.ok) {
          const applied = await markCommandFailed(
            row.commandId,
            postCreate.error,
            {
              retryable: true,
              attempts: row.attempts,
              sessionId: result.sessionId,
              result: {
                status: "created",
                session_id: result.sessionId,
                source: row.source,
                post_create_error: postCreate.error,
              },
              claim,
            },
          );
          if (applied) out.queued += 1;
          continue;
        }
        const applied = await markCommandSucceeded(
          row.commandId,
          {
            status: "created",
            session_id: result.sessionId,
            source: row.source,
          },
          result.sessionId,
          claim,
        );
        if (applied) out.succeeded += 1;
      } else {
        const message = String(
          result.error?.body?.error ??
            result.reason ??
            "Failed to create queued session",
        );
        const retryable =
          result.retryable ?? isRetryableCreateError(result.error?.status);
        const applied = await markCommandFailed(row.commandId, message, {
          retryable,
          attempts: row.attempts,
          claim,
        });
        if (applied) {
          if (retryable) out.queued += 1;
          else out.failed += 1;
        }
      }
    } finally {
      stop();
    }
  }

  return out;
}

async function executeQueuedProvision(
  row: SessionLifecycleCommandRow,
  claim: LifecycleCommandClaim,
): Promise<"succeeded" | "queued" | "failed" | "stale"> {
  if (!row.sessionId) {
    const applied = await markCommandFailed(
      row.commandId,
      "provision_session command missing sessionId",
      { retryable: false, attempts: row.attempts, claim },
    );
    return applied ? "failed" : "stale";
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  const [session] = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, row.projectId),
        eq(projectSessions.sessionId, row.sessionId),
      ),
    )
    .limit(1);
  const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
  const binding = await getProjectTaskWorkerBinding(db, row.sessionId);
  if (
    !session ||
    !taskId ||
    metadata.task_liveness_binding_status !== "bound" ||
    metadata.task_liveness_bound_task_id !== taskId ||
    binding?.taskId !== taskId ||
    binding.status !== "doing"
  ) {
    const applied = await markCommandFailed(
      row.commandId,
      "task worker reservation has no matching live binding",
      { retryable: false, attempts: row.attempts, sessionId: row.sessionId, claim },
    );
    return applied ? "failed" : "stale";
  }

  if (session.status === "queued") {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.projectId, row.projectId))
      .limit(1);
    if (!project) {
      const applied = await markCommandFailed(row.commandId, "Project not found", {
        retryable: false,
        attempts: row.attempts,
        sessionId: row.sessionId,
        claim,
      });
      return applied ? "failed" : "stale";
    }
    const userId = session.createdBy ?? row.actorUserId ??
      (await resolveProjectAutomationActor(row.accountId));
    if (!userId) {
      const applied = await markCommandFailed(row.commandId, "No session owner available", {
        retryable: false,
        attempts: row.attempts,
        sessionId: row.sessionId,
        claim,
      });
      return applied ? "failed" : "stale";
    }
    try {
      await allocateRuntimeOnOpen(
        { row: project, userId },
        session,
        row.projectId,
        row.sessionId,
        { awaitKickoff: true },
      );
    } catch (error) {
      const applied = await markCommandFailed(
        row.commandId,
        error instanceof Error ? error.message : String(error),
        {
          retryable: true,
          attempts: row.attempts,
          sessionId: row.sessionId,
          claim,
        },
      );
      return applied ? "queued" : "stale";
    }
  } else if (!['provisioning', 'running'].includes(session.status)) {
    const applied = await markCommandFailed(
      row.commandId,
      `task worker reservation is ${session.status}`,
      { retryable: false, attempts: row.attempts, sessionId: row.sessionId, claim },
    );
    return applied ? "failed" : "stale";
  }

  const applied = await markCommandSucceeded(
    row.commandId,
    { status: "provisioning_started", task_id: taskId },
    row.sessionId,
    claim,
  );
  return applied ? "succeeded" : "stale";
}

/**
 * Drain one queued `continue_session` command — the durable face of "deliver
 * this follow-up into the session" (today: the approval-resume backstop). The
 * consumed-marker check runs at DRAIN time, not enqueue time, so a live held
 * request that picked the decision up during the grace window cleanly turns
 * this into a no-op instead of a duplicate prompt.
 */
async function executeQueuedStop(
  row: SessionLifecycleCommandRow,
  claim: LifecycleCommandClaim,
): Promise<"succeeded" | "queued" | "failed" | "stale"> {
  if (!row.sessionId) {
    const applied = await markCommandFailed(
      row.commandId,
      "stop_session command missing sessionId",
      {
        retryable: false,
        attempts: row.attempts,
        claim,
      },
    );
    return applied ? "failed" : "stale";
  }
  // Server-owned lifecycle stops must converge after the account's last human
  // owner leaves. stopSession uses this value only for stoppedBy metadata.
  const userId =
    row.actorUserId ??
    (await resolveProjectAutomationActor(row.accountId)) ??
    "system:session-lifecycle";
  const result = await stopSession({
    projectId: row.projectId,
    sessionId: row.sessionId,
    accountId: row.accountId,
    userId,
  });
  const outcome = classifyStopCommandResult(result);
  if (outcome === "succeeded") {
    const applied = await markCommandSucceeded(
      row.commandId,
      { status: "stopped", response: result.body },
      row.sessionId,
      claim,
    );
    return applied ? "succeeded" : "stale";
  }
  const retryable = outcome === "retry";
  const applied = await markCommandFailed(
    row.commandId,
    String(result.body.error ?? `stop failed: ${result.status}`),
    {
      retryable,
      attempts: row.attempts,
      sessionId: row.sessionId,
      // A terminal worker stop is a durable safety fence. Provisioning and
      // transient provider failures remain queued until the runtime converges.
      unbounded: retryable,
      claim,
    },
  );
  return applied ? (retryable ? "queued" : "failed") : "stale";
}

async function executeQueuedContinue(
  row: SessionLifecycleCommandRow,
  claim: LifecycleCommandClaim,
): Promise<"succeeded" | "queued" | "failed" | "stale"> {
  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!row.sessionId || !text) {
    const applied = await markCommandFailed(
      row.commandId,
      "continue_session command missing sessionId or text",
      { retryable: false, attempts: row.attempts, claim },
    );
    return applied ? "failed" : "stale";
  }

  // A task-worker prompt depends on the provisioning outbox row. Ordering by
  // timestamp is insufficient because another drainer can claim both rows.
  if (row.idempotencyKey?.startsWith("task-worker:")) {
    const provisionKey = row.idempotencyKey.replace(
      /^task-worker:/,
      "task-worker-provision:",
    );
    const [provision] = await db
      .select({ status: sessionLifecycleCommands.status })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, provisionKey))
      .limit(1);
    if (!provision || ["failed", "dead_lettered"].includes(provision.status)) {
      const applied = await markCommandFailed(
        row.commandId,
        "task worker provisioning did not succeed",
        { retryable: false, attempts: row.attempts, sessionId: row.sessionId, claim },
      );
      return applied ? "failed" : "stale";
    }
    if (provision.status !== "succeeded") {
      const applied = await deferLifecycleCommand(
        row.commandId,
        claim,
        "waiting_for_task_worker_provisioning",
      );
      return applied ? "queued" : "stale";
    }
  }

  if (payload.executionId) {
    const [exec] = await db
      .select({ resultSummary: connectorCalls.resultSummary })
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, payload.executionId))
      .limit(1);
    const summary = (exec?.resultSummary ?? {}) as Record<string, unknown>;
    if (summary.consumed_at) {
      const applied = await markCommandSucceeded(
        row.commandId,
        { status: "skipped", reason: "consumed_in_band" },
        row.sessionId,
        claim,
      );
      return applied ? "succeeded" : "stale";
    }
  }

  try {
    const delivery = await continueSession({
      source: row.source as SessionInvocationSource,
      sessionId: row.sessionId,
      text,
      messageId: payload.messageId,
      userId: row.actorUserId,
    });
    if (delivery === "delivered") {
      const applied = await markCommandSucceeded(
        row.commandId,
        { status: "delivered" },
        row.sessionId,
        claim,
      );
      return applied ? "succeeded" : "stale";
    }
    // 'pending' = runtime not ready in time — worth another pass. 'no-session'
    // and 'failed' are terminal for this command.
    const retryable = delivery === "pending";
    const applied = await markCommandFailed(
      row.commandId,
      `delivery outcome: ${delivery}`,
      {
        retryable,
        attempts: row.attempts,
        sessionId: row.sessionId,
        claim,
      },
    );
    return applied ? (retryable ? "queued" : "failed") : "stale";
  } catch (e) {
    const applied = await markCommandFailed(
      row.commandId,
      (e as Error).message || "continue_session threw",
      {
        retryable: true,
        attempts: row.attempts,
        sessionId: row.sessionId,
        claim,
      },
    );
    return applied ? "queued" : "stale";
  }
}

async function executeQueuedCreate(
  row: SessionLifecycleCommandRow,
): Promise<SessionLifecycleResult> {
  const payload = row.payload as unknown as QueuedCreateSessionPayload;
  if (row.sessionId) {
    const [session] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    if (session) {
      return {
        status: "created",
        commandId: row.commandId,
        sessionId: row.sessionId,
        row: session,
        retryable: true,
      };
    }
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, row.projectId))
    .limit(1);
  if (!project) {
    return {
      status: "failed",
      commandId: row.commandId,
      retryable: false,
      error: { status: 404, body: { error: "Project not found" } },
    };
  }
  const userId =
    row.actorUserId ?? (await resolveProjectAutomationActor(project.accountId));
  if (!userId) {
    return {
      status: "failed",
      commandId: row.commandId,
      retryable: false,
      error: {
        status: 409,
        body: { error: "No account owner available to own the session" },
      },
    };
  }
  let requestingPrincipalType = payload.requestingPrincipalType;
  if (
    requestingPrincipalType !== "human" &&
    requestingPrincipalType !== "service_account"
  ) {
    const [serviceAccount] = row.actorUserId
      ? await db
          .select({ serviceAccountId: serviceAccounts.serviceAccountId })
          .from(serviceAccounts)
          .where(
            and(
              eq(serviceAccounts.serviceAccountId, row.actorUserId),
              eq(serviceAccounts.accountId, project.accountId),
            ),
          )
          .limit(1)
      : [];
    requestingPrincipalType = serviceAccount ? "service_account" : "human";
  }
  return executeCreateSession({
    source: row.source as CreateSessionCommand["source"],
    project,
    userId,
    requestingPrincipalType,
    body: payload.body ?? {},
    metadata: payload.metadata,
    platformMetaGoalPush: payload.platformMetaGoalPush,
    extraEnvVars: payload.extraEnvVars,
    visibility: payload.visibility,
    mayManageSystemConnections: payload.mayManageSystemConnections,
    enforceAccountCap: payload.enforceAccountCap,
    queuePolicy: "never",
    postCreate: payload.postCreate,
    // Replay the origin-derivation signals captured at enqueue time so a
    // queued backend create keeps origin 'backend'.
    authType: payload.authType,
    apiKeyType: payload.apiKeyType,
    inSession: payload.inSession,
    callerSessionId: payload.callerSessionId,
  });
}

async function executeCreateSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
  // Re-check at execution time. A queued create can outlive its caller's task.
  const confinement = await taskWorkerCreateConfinement(
    command.callerSessionId,
  );
  if (confinement) return confinement;
  const metadata = {
    source: command.source,
    ...(command.metadata ?? {}),
  };
  const result = await createProjectSession({
    project: command.project,
    userId: command.userId,
    requestingPrincipalType: command.requestingPrincipalType,
    body: command.body,
    enforceAccountCap: command.enforceAccountCap,
    metadata,
    platformMetaGoalPush: command.platformMetaGoalPush,
    extraEnvVars: command.extraEnvVars,
    request: command.request,
    visibility: command.visibility,
    authType: command.authType,
    apiKeyType: command.apiKeyType,
    inSession: command.inSession,
    callerSessionId: command.callerSessionId,
    mayManageSystemConnections: command.mayManageSystemConnections,
  });

  if (result.error) {
    return {
      status: "failed",
      error: result.error,
      headers: result.headers,
      retryable: isRetryableCreateError(result.error.status),
    };
  }
  return {
    status: "created",
    sessionId: result.row!.sessionId,
    row: result.row,
    headers: result.headers,
    retryable: true,
  };
}

async function applyPostCreateActions(input: {
  projectId: string;
  sessionId: string;
  actions?: SessionLifecyclePostCreateAction[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.actions?.length) return { ok: true };
  try {
    for (const action of input.actions) {
      if (action.type === "bind_chat_thread") {
        await bindChatThread({
          projectId: input.projectId,
          platform: action.platform,
          workspaceId: action.workspaceId,
          threadId: action.threadId,
          sessionId: input.sessionId,
        });
      } else if (action.type === "deliver_prompt") {
        const outcome = await continueSession({
          source: action.source,
          sessionId: input.sessionId,
          text: action.text,
          userId: action.userId ?? undefined,
        });
        if (outcome !== "delivered") {
          return { ok: false, error: `initial prompt delivery ${outcome}` };
        }
      }
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[session-lifecycle] post-create action failed", {
      sessionId: input.sessionId,
      error,
    });
    return { ok: false, error };
  }
}

function isRetryableCreateError(status?: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function sandboxExternalId(
  result: NonNullable<Awaited<ReturnType<typeof openSession>>>,
): string | null {
  return (
    (result.sandbox as { external_id?: string } | null)?.external_id ?? null
  );
}

function isProviderName(value: string | null): value is ProviderName {
  return (
    value === "daytona" ||
    value === "platinum" ||
    value === "e2b" ||
    value === "local-docker"
  );
}

async function postPrompt(
  externalId: string,
  opencodeSessionId: string,
  text: string,
  userId: string,
  /** The session this prompt is FOR. Passed as the caller binding so the
   *  isolation guard proves the target matches, rather than being waived. */
  callerSessionId: string,
  messageId?: string | null,
): Promise<boolean> {
  const body = new TextEncoder().encode(
    JSON.stringify(openCodePromptPayload(text, messageId)),
  );
  try {
    const res = await forwardToSandbox(
      externalId,
      DAEMON_PORT,
      { kind: "principal", userId, callerSessionId, sandboxAuthored: false },
      "POST",
      `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      `?directory=${encodeURIComponent(WORKSPACE)}`,
      new Headers({ "Content-Type": "application/json" }),
      body.buffer as ArrayBuffer,
      config.KORTIX_URL ?? "",
    );
    if (res.ok || res.status === 204) return true;
    if (res.status !== 404)
      console.warn("[session-lifecycle] prompt_async non-ok", {
        status: res.status,
      });
    return false;
  } catch (err) {
    // A connection refused/reset while the sandbox finishes resuming — treat as a
    // retryable miss (the deliver loop will heal + retry) instead of letting it
    // bubble up and silently drop the turn.
    console.warn("[session-lifecycle] prompt_async threw (will retry)", {
      error: String(err),
    });
    return false;
  }
}
