/**
 * Deliver one prompt into a session: the fast path to an awake box, or the
 * slow path that wakes it, converges its env, and retries through the
 * transient failures a freshly woken runtime throws.
 */

import * as lifecycleStore from './store';
import { sessionAttachmentStore } from '../lib/session-attachments';
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import type { SandboxRecord } from '../../sandbox-proxy/backend';
import { config } from '../../config';
import {
  bindSessionTurnIdentity,
  channelPrompterForOnBehalfOf,
  clearSessionOnBehalfOfForPrompt,
} from '../lib/on-behalf-of';
import { logger } from '../../lib/logger';
import { materializePromptAttachments } from './prompt-attachment-materializer';
import { confirmPromptLanded, promptNeedsLandingProof } from './prompt-landing-proof';
import { writeRuntimePromptFile } from './runtime-prompt-file';
import { db } from '../../shared/db';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { resolveProjectAutomationActor } from './actor';
import { awakeDeliveryTarget, deliverAfterWake, undoDeliveryWake, type SendOutcome } from './deliver';
import { sessionTransitionLeaves, transitionSession } from './status-transitions';
import { repairLegacyInlineAttachments } from './legacy-inline-attachment-repair';
import type {
  ContinueSessionCommand,
  LegacyInlineAttachmentRepairMetadata,
  SessionDeliveryOutcome,
} from './types';
import {
  PromptNeverLandedError,
  postPrompt,
  readLegacyRuntimeMessage,
  updateLegacyRuntimePart,
} from './runtime-client';

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
  // The session token acts as the person who starts this turn (spec
  // 2026-09-22 §2.3). The prompt route marks its human prompts
  // `bindTurnIdentity`; trigger and channel deliveries are classified by
  // source. A person binds `user_id` + `on_behalf_of`; a non-person (`null`)
  // clears `on_behalf_of` and keeps `user_id` — never the automation actor,
  // which is the account owner.
  const turnPrompter = command.bindTurnIdentity
    ? (command.userId ?? undefined)
    : channelPrompterForOnBehalfOf({
        source: command.source,
        userId: command.userId ?? null,
        slackRequiresUserIdentity: config.SLACK_REQUIRE_USER_IDENTITY !== false,
        teamsRequiresUserIdentity: config.TEAMS_REQUIRE_USER_IDENTITY !== false,
      });
  // The clear lands BEFORE the wake: a wake that re-mints the token reads its
  // stamp and must not restore `on_behalf_of` for the automation actor.
  if (turnPrompter === null) {
    await clearSessionOnBehalfOfForPrompt({ accountId: session.accountId, sessionId, prompterUserId: null });
  }
  // The bind runs alongside the wake (a re-mint mints for this same person) and
  // is awaited before the prompt is posted: a failed bind fails the delivery,
  // so no turn runs as the previous prompter.
  const turnIdentity =
    typeof turnPrompter === 'string'
      ? bindSessionTurnIdentity({ accountId: session.accountId, sessionId, prompterUserId: turnPrompter })
      : Promise.resolve(false);
  // Observed here so a delivery that never reaches `sendPrompt` leaves no
  // unhandled rejection; `sendPrompt` awaits the original and throws.
  turnIdentity.catch(() => undefined);
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
          keepNativeInline: true,
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
  const sendPrompt = async (
    externalId: string,
    opencodeSessionId: string,
    sandboxRecord?: SandboxRecord,
  ): Promise<SendOutcome> => {
    await repairLegacyBeforeDelivery(externalId, opencodeSessionId);
    await beforeSend?.();
    await turnIdentity;
    let bodyBytes = 0;
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
        noReply: command.noReply,
        accountId: session.accountId,
        projectId: session.projectId,
        sandboxRecord,
        onBodyBytes: (bytes) => {
          bodyBytes = Math.max(bodyBytes, bytes);
        },
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
    //
    // Only a body the edge can drop is read back: see `promptNeedsLandingProof`.
    if ((delivery === 'accepted' || delivery === 'deduplicated') && promptNeedsLandingProof(bodyBytes)) {
      const landing = await confirmPromptLanded({
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
      if (landing === 'unknown') {
        logger.warn('[session-lifecycle] large prompt accepted; the landing read could not answer', {
          session_id: sessionId,
          wire_message_id: command.wireMessageId,
          delivery,
          body_bytes: bodyBytes,
        });
      }
      if (landing === 'missing') {
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

  // The pre-check skips a write on the hot path (a running session). The
  // transition re-checks the status and the tombstone in its own WHERE, so a
  // delete that lands after the read above is not undone.
  const wokeFrom =
    sessionTransitionLeaves('wake', session.status) &&
    (await transitionSession('wake', sessionId, { error: null }))
      ? session.status
      : null;
  const outcome = await deliverAfterWake({ command, session, sessionId, userId, awakeEarly, sendPrompt, beforeSend, tl });
  // The wake above is a claim that a runtime is coming. A delivery that ends
  // with no runtime (`unreachable`, `pending`, `no-session`) takes the claim
  // back, or the session reads `running` over a stopped box through every
  // retry. `failed` and `not-landed`
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
