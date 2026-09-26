/**
 * Deliver one prompt into a session: the fast path to an awake box, or the
 * slow path that wakes it, converges its env, and retries through the
 * transient failures a freshly woken runtime throws.
 */

import * as lifecycleStore from './store';
import { sessionAttachmentStore } from '../lib/session-attachments';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { config } from '../../config';
import { channelPrompterForOnBehalfOf, clearSessionOnBehalfOfForPrompt } from '../lib/on-behalf-of';
import { logger } from '../../lib/logger';
import { materializePromptAttachments } from './prompt-attachment-materializer';
import { confirmPromptLanded } from './prompt-landing-proof';
import { writeRuntimePromptFile } from './runtime-prompt-file';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { recordSessionActivity } from '../session-activity';
import { deliveryCountsAsActivity } from './delivery-activity';
import { openSession } from '../routes/shared';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { resolveProjectAutomationActor } from './actor';
import { type DeliveryTarget, type SendOutcome, deliverWithRetry } from './deliver';
import { sessionTransitionLeaves, transitionSession } from './status-transitions';
import { repairLegacyInlineAttachments } from './legacy-inline-attachment-repair';
import type {
  ContinueSessionCommand,
  LegacyInlineAttachmentRepairMetadata,
  SessionDeliveryOutcome,
} from './types';
import {
  DAEMON_PORT,
  PromptNeverLandedError,
  postPrompt,
  readLegacyRuntimeMessage,
  updateLegacyRuntimePart,
} from './runtime-client';

const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function continueSession(
  command: ContinueSessionCommand,
  // F2: the queued `continue_session` row's stable identity, when this
  // delivery originates from the durable queue (`executeQueuedContinue`,
  // `applyPostCreateActions`'s `deliver_prompt` action). Sent to `postPrompt`
  // as the `Idempotency-Key` — see the note there for why this must be
  // STABLE across every retry of ONE command and DISTINCT across different
  // commands, even when their prompt text is byte-identical. Callers with no
  // durable row of their own (direct API/channel delivery) get a fresh
  // `randomUUID()` per call instead — still stable across THIS call's own
  // internal `deliverWithRetry` retries (computed once, below, outside that
  // loop), just not across separate invocations, which those callers never
  // rely on for dedupe.
  commandId?: string,
  tl?: ProvisionTimeline,
  beforeSend?: () => Promise<void>,
): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = command;
  const idempotencyKey = commandId ?? randomUUID();
  // The fast-path target is one JOINED read of the session and its sandbox, and
  // it does not depend on the session read below — so it goes out with it
  // instead of two round trips after it. A box that turns out not to be awake
  // yields null and the slow path runs exactly as before.
  const awakeEarly = awakeDeliveryTarget(command.sessionId);
  awakeEarly.catch(() => undefined);
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
      projectMetadata: sql<Record<string, unknown> | null>`(SELECT p.metadata FROM kortix.projects p WHERE p.project_id = "kortix"."project_sessions"."project_id")`,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  if (!session) return 'no-session';
  // A parked session is a parked RUNTIME (`runtime_boot_failed` /
  // `runtime_wake_failed` stamp it), not a bad prompt. It is deliberately not
  // auto-restarted — see the 2026-08-24 learning — but the prompt waits for the
  // restart instead of being destroyed by it.
  if (session.status === 'failed') return 'unreachable';
  // deleteSession() stamps metadata.deletedAt and leaves the row 'stopped' —
  // the same status a normal hibernate uses. Without this check a queued
  // follow-up (Slack reply, scheduled trigger, etc.) would revive a session
  // the user explicitly deleted.
  const sessionMeta = (session.metadata ?? {}) as LegacyInlineAttachmentRepairMetadata;
  if (typeof sessionMeta.deletedAt === 'string') return 'no-session';
  if (command.projectId && command.projectId !== session.projectId) {
    console.warn('[session-lifecycle] command project does not own the session; refusing delivery', {
      sessionId,
      commandProjectId: command.projectId,
    });
    return 'no-session';
  }
  const userId = command.userId ?? (await resolveProjectAutomationActor(session.accountId));
  if (!userId) {
    console.warn('[session-lifecycle] no actor for follow-up delivery', { sessionId });
    return 'pending';
  }
  // Spec 2026-09-22 §2.3: a prompt from anyone other than the session's
  // `on_behalf_of` human clears it. The HTTP prompt route clears for human
  // prompters itself; trigger and channel deliveries arrive here.
  const channelPrompter = channelPrompterForOnBehalfOf({
    source: command.source,
    userId: command.userId ?? null,
    slackRequiresUserIdentity: config.SLACK_REQUIRE_USER_IDENTITY !== false,
    teamsRequiresUserIdentity: config.TEAMS_REQUIRE_USER_IDENTITY !== false,
  });
  if (channelPrompter !== undefined) {
    await clearSessionOnBehalfOfForPrompt({
      accountId: session.accountId,
      sessionId,
      prompterUserId: channelPrompter,
    });
  }
  const pendingAttachmentNames = sessionMeta.pending_prompt?.attachment_names;
  const shouldRepairLegacyInlineAttachments =
    command.isPendingFirstPrompt !== true &&
    Array.isArray(pendingAttachmentNames) &&
    pendingAttachmentNames.length > 0 &&
    typeof sessionMeta.legacy_inline_attachments_repaired_at !== 'string';
  const legacyRepairByExternalId = new Map<string, Promise<void>>();
  const repairLegacyBeforeDelivery = (
    externalId: string,
    opencodeSessionId: string,
  ): Promise<void> => {
    if (!shouldRepairLegacyInlineAttachments) return Promise.resolve();
    const existing = legacyRepairByExternalId.get(externalId);
    if (existing) return existing;
    const repair = repairLegacyInlineAttachments({
      sessionId,
      externalId,
      opencodeSessionId,
      userId,
      loadPendingFirst: () => lifecycleStore.loadLegacyPendingFirstPrompt(sessionId),
      readMessage: (messageId) =>
        readLegacyRuntimeMessage({
          externalId,
          opencodeSessionId,
          sessionId,
          userId,
          messageId,
        }),
      materialize: (parts, key) =>
        materializePromptAttachments({
          parts,
          externalId,
          sessionId,
          userId,
          materializationKey: key,
          writeFile: writeRuntimePromptFile,
          readAttachment: (scope) => sessionAttachmentStore().read(scope),
          // The runtime already holds this message's native images inline;
          // only the legacy non-native parts need a file behind them.
          inlineBudgetBytes: Number.POSITIVE_INFINITY,
        }),
      updatePart: ({ messageId, partId, text: replacementText }) =>
        updateLegacyRuntimePart({
          externalId,
          opencodeSessionId,
          sessionId,
          userId,
          messageId,
          partId,
          text: replacementText,
        }),
      markRepaired: () => lifecycleStore.markLegacyInlineAttachmentsRepaired(sessionId),
    }).then(() => undefined);
    legacyRepairByExternalId.set(externalId, repair);
    return repair;
  };
  const sendPrompt = async (externalId: string, opencodeSessionId: string): Promise<SendOutcome> => {
    await repairLegacyBeforeDelivery(externalId, opencodeSessionId);
    await beforeSend?.();
    const delivery = await postPrompt(
      externalId,
      opencodeSessionId,
      text,
      userId,
      sessionId,
      idempotencyKey,
      {
        parts: command.parts,
        overrides: command.overrides,
        wireMessageId: command.wireMessageId,
        materializationKey: command.materializationKey,
        attachmentProjectId: resolveFeatureFlag(session.projectMetadata, 'session_transcript_history')
          ? session.projectId : undefined,
        accountId: session.accountId,
        projectId: session.projectId,
      },
    );
    // ACCEPTANCE IS NOT DELIVERY. `prompt_async` answers for the request, and
    // the sandbox edge discards a body over its size ceiling then answers 200
    // on retry — so a prompt can be "accepted" and never exist. Read it back
    // before anything closes the row. See `prompt-landing-proof.ts`.
    //
    // `deduplicated` is checked too: it is the proxy asserting an EARLIER
    // POST under this key delivered, and that assertion is exactly what the
    // proof exists to test. And a refusal THROWS rather than returning false:
    // `deliverWithRetry` re-sends a false under the same Idempotency-Key, the
    // proxy's claim answers `duplicate`, and the row closed as delivered anyway
    // — 3.6 s later (review finding, 2026-09-05). The throw escapes the loop so
    // the row can go back out under a fresh attempt, key and wire id.
    if (delivery === 'accepted' || delivery === 'deduplicated') {
      const landed = await confirmPromptLanded({
        messageId: command.wireMessageId,
        readMessage: (messageId) =>
          readLegacyRuntimeMessage({
            externalId,
            opencodeSessionId,
            sessionId,
            userId,
            messageId,
          }),
      });
      if (!landed) {
        logger.error('[session-lifecycle] prompt accepted but never became a message', {
          session_id: sessionId,
          wire_message_id: command.wireMessageId,
          delivery,
          parts: command.parts?.length ?? 0,
        });
        throw new PromptNeverLandedError(command.wireMessageId);
      }
    }
    if (delivery === 'accepted' && command.isPendingFirstPrompt === true) {
      // This first message used the canonical command-id path. The marker keeps
      // later prompts from entering repair. If this write fails, repair compares
      // the transcript against this exact command-id XML and records the marker.
      await lifecycleStore.markLegacyInlineAttachmentsRepaired(sessionId);
    }
    // Carry the reachability verdict through to `deliverWithRetry` rather than
    // flattening it to false — a down path must not spend the dead-letter
    // budget. See SendOutcome.
    if (delivery === 'unreachable') return 'unreachable';
    return delivery !== 'failed';
  };

  // Server-side delivery is the first prompt for sessions created without one.
  void generateSessionTitleFromFirstPrompt({
    sessionId,
    projectId: session.projectId,
    accountId: session.accountId,
    userId,
    firstPromptText: text,
  });

  // Loaded LAZILY: only `openSession` (the slow path that wakes a box) reads
  // the project row, and the session's foreign key already proves it exists.
  // On the fast path this saved a full round trip per delivery.
  let projectRow: typeof projects.$inferSelect | undefined;
  const loadProject = async () =>
    (projectRow ??= (
      await db.select().from(projects).where(eq(projects.projectId, session.projectId)).limit(1)
    )[0]);

  // The pre-check skips a write on the hot path (a running session). The
  // transition re-checks the status and the tombstone in its own WHERE, so a
  // delete that lands after the read above is not undone.
  const wokeFrom =
    sessionTransitionLeaves('wake', session.status) &&
    (await transitionSession('wake', sessionId, { error: null }))
      ? session.status
      : null;
  const deliverAfterWake = async (): Promise<SessionDeliveryOutcome> => {
    const openOnce = async () => {
      const project = await loadProject();
      if (!project) return null;
      const loaded = { row: project, userId };
      await beforeSend?.();
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

    tl?.mark('session-read');

    // FAST PATH — the box is already awake. `openSession` is /start: a provider
    // status call plus a daemon health probe, ~0.5–0.9s per delivery even when
    // nothing needs waking, and it ran on EVERY queued message. When the session
    // row is running, its sandbox row is active and the OpenCode pin exists, the
    // delivery target is fully known from the DB; the POST goes through the
    // proxy, whose own wake-and-retry loop and `deliverWithRetry.reopen` (the
    // full open) cover a box that turns out to be asleep after all. A cold or
    // stopping session takes the slow path below exactly as before.
    const awake = await awakeEarly;
    if (awake && !command.opencodeEnv) {
      tl?.mark('open-ready-fast');
      return deliverWithRetry({
        sessionId,
        opened: awake,
        reopen: async () => {
          const healed = await openOnce();
          if (!healed) return null;
          return {
            stage: healed.stage,
            externalId: sandboxExternalId(healed),
            opencodeSessionId: healed.opencode_session_id,
          };
        },
        send: sendPrompt,
      }).catch(notLandedOutcome);
    }

    const deadline = Date.now() + READY_DEADLINE_MS;
    let opened: Awaited<ReturnType<typeof openOnce>>;
    for (;;) {
      opened = await openOnce();
      if (!opened) return 'no-session';
      if (opened.stage === 'ready') {
        tl?.mark('open-ready');
        break;
      }
      // Runtime down, prompt fine. See `deliverWithRetry`'s identical branch.
      if (opened.stage === 'failed' || opened.stage === 'stopped') return 'unreachable';
      if (Date.now() >= deadline) {
        console.warn('[session-lifecycle] runtime not ready before delivery deadline', {
          sessionId,
          stage: opened.stage,
        });
        return 'pending';
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Converge the box BEFORE the prompt goes on the wire — every time, not only
    // when this prompt carries an `opencodeEnv` override. The proxied
    // `prompt_async` route has always done this (sandbox-proxy/pre-prompt-env-sync);
    // this wake path did it only behind `if (command.opencodeEnv)`, so an ordinary
    // `session.send()` prompt onto a box that had to be WOKEN reached OpenCode
    // with whatever the box had at boot: a stale gateway base URL after a
    // KORTIX_URL rotation, stale secrets, a stale model catalog. The sync is
    // cheap and self-deduping (revision + model signature); an unchanged box
    // costs one skipped push.
    {
      const sandbox = opened.sandbox as {
        external_id?: string | null;
        provider?: string | null;
      } | null;
      const externalId = sandbox?.external_id ?? null;
      const providerName = sandbox?.provider ?? null;
      if (!externalId || !isProviderName(providerName)) {
        console.warn('[session-lifecycle] runtime env sync target is incomplete', {
          sessionId,
          hasExternalId: !!externalId,
          provider: providerName,
        });
        return 'pending';
      }
      try {
        const [serviceKey, ingress] = await Promise.all([
          serviceKeyForExternalId(externalId),
          resolveSandboxIngress(externalId, { port: DAEMON_PORT, transport: 'http' }),
        ]);
        if (!serviceKey) throw new Error('sandbox service key is unavailable');
        await syncSandboxEnvForPrompt({
          projectId: session.projectId,
          sessionId,
          externalId,
          serviceKey,
          previewUrl: ingress.url,
          providerHeaders: ingress.headers,
          providerName,
          opencodeEnv: command.opencodeEnv,
        });
      } catch (err) {
        console.warn('[session-lifecycle] runtime env sync failed before prompt delivery', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'pending';
      }
    }

    // Runtime is ready — hand off the prompt, healing + retrying through the
    // transient failures a freshly-woken sandbox throws (rotated opencode session
    // 404, daemon 5xx while it binds, externalId/opencode_session_id briefly
    // null). Bounce to 'pending' only after the bounded window genuinely exhausts;
    // the old code gave up on the first hiccup and dropped the user's message.
    const toTarget = (o: NonNullable<Awaited<ReturnType<typeof openOnce>>>): DeliveryTarget => ({
      stage: o.stage,
      externalId: sandboxExternalId(o),
      opencodeSessionId: o.opencode_session_id,
    });

    tl?.mark('env-sync');
    return deliverWithRetry({
      sessionId,
      opened: toTarget(opened),
      reopen: async () => {
        const healed = await openOnce();
        return healed ? toTarget(healed) : null;
      },
      send: sendPrompt,
    })
      .then((outcome) => {
        // Stamp the sidebar's sort key for a prompt the PLATFORM delivered — a
        // spawned sub-session, a trigger, a channel message, an approval resume.
        // The preview proxy already does this for a prompt a browser sends; this
        // path never did, so those sessions fell back to `updated_at`, which a
        // dozen background writers advance with no turn behind them, and they
        // visibly reordered themselves in the sidebar. Best-effort and never
        // awaited, exactly as at the proxy: a failed stamp degrades ordering and
        // must never degrade the prompt.
        if (deliveryCountsAsActivity(outcome)) {
          void recordSessionActivity({ sessionId, projectId: session.projectId });
        }
        return outcome;
      })
      .catch(notLandedOutcome);
  };
  const outcome = await deliverAfterWake();
  // The wake above is a claim that a runtime is coming. A delivery that ends
  // with no runtime (`unreachable`, `pending`, `no-session`) takes the claim
  // back, or the session reads `running` over a stopped box and holds a
  // concurrent-session slot through every retry. `failed` and `not-landed`
  // reached a live runtime, so they keep it.
  if (wokeFrom && (outcome === 'unreachable' || outcome === 'pending' || outcome === 'no-session')) {
    await undoDeliveryWake(sessionId, wokeFrom).catch((err) =>
      console.warn('[session-lifecycle] failed to undo the pre-delivery wake', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return outcome;
}

/**
 * Put a session the delivery woke back to the status it woke from — only
 * while it still reads `running` and no `active` sandbox row backs it. A wake
 * that did bring the box up (`openSession` finalized the sandbox row) keeps
 * the session running.
 */
async function undoDeliveryWake(sessionId: string, wokeFrom: string): Promise<void> {
  await transitionSession(wokeFrom === 'completed' ? 'unwakeCompleted' : 'unwake', sessionId, {
    guard: sql`NOT EXISTS (
      SELECT 1 FROM ${sessionSandboxes} AS box
       WHERE box.session_id = ${sessionId}
         AND box.status = 'active')`,
  });
}

/** A refused landing proof is its own outcome; anything else keeps throwing. */
function notLandedOutcome(error: unknown): SessionDeliveryOutcome {
  if (error instanceof PromptNeverLandedError) return 'not-landed';
  throw error;
}

/**
 * The delivery target for a session whose box is ALREADY awake, from the DB
 * alone — or null, which means "take the full open path". Cheap: two indexed
 * reads, no provider or daemon round-trip.
 *
 * The two reads are keyed on the same session id and neither consumes the
 * other's result, so they go out TOGETHER: one round trip instead of two on
 * every delivery, which is ~100 ms wherever the API and its database sit in
 * different regions.
 */
async function awakeDeliveryTarget(sessionId: string): Promise<DeliveryTarget | null> {
  const [[session], [box]] = await Promise.all([
    db
      .select({
        status: projectSessions.status,
        opencodeSessionId: projectSessions.opencodeSessionId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1),
    db
      .select({ status: sessionSandboxes.status, externalId: sessionSandboxes.externalId })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1),
  ]);
  if (!session || session.status !== 'running' || !session.opencodeSessionId) return null;
  if (!box || box.status !== 'active' || !box.externalId) return null;
  return {
    stage: 'ready',
    externalId: box.externalId,
    opencodeSessionId: session.opencodeSessionId,
  };
}

function sandboxExternalId(
  result: NonNullable<Awaited<ReturnType<typeof openSession>>>,
): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

function isProviderName(value: string | null): value is ProviderName {
  return value === 'daytona' || value === 'platinum' || value === 'e2b';
}
