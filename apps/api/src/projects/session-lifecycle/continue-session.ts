import * as lifecycleStore from './store';
import { sessionAttachmentStore } from '../lib/session-attachments';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { config } from '../../config';
import { channelPrompterForOnBehalfOf, clearSessionOnBehalfOfForPrompt } from '../lib/on-behalf-of';
import { logger } from '../../lib/logger';
import { materializePromptAttachments } from './prompt-attachment-materializer';
import { confirmPromptLanded } from './prompt-landing-proof';
import { writeRuntimePromptFile } from './runtime-prompt-file';
import { db } from '../../shared/db';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { resolveProjectAutomationActor } from './actor';
import { awakeDeliveryTarget, deliverAfterWake, undoDeliveryWake, type SendOutcome } from './deliver';
import { sessionTransitionLeaves, transitionSession } from './status-transitions';
import { repairLegacyInlineAttachments } from './legacy-inline-attachment-repair';
import type { ContinueSessionCommand, LegacyInlineAttachmentRepairMetadata, SessionDeliveryOutcome } from './types';
import {
  PromptNeverLandedError,
  postPrompt,
  readLegacyRuntimeMessage,
  updateLegacyRuntimePart,
} from './runtime-client';

export async function continueSession(
  command: ContinueSessionCommand,
  commandId?: string,
  tl?: ProvisionTimeline,
  beforeSend?: () => Promise<void>,
): Promise<SessionDeliveryOutcome> {
  const { sessionId } = command;
  const idempotencyKey = commandId ?? randomUUID();
  const awakeEarly = awakeDeliveryTarget(command.sessionId);
  awakeEarly.catch(() => undefined);
  const session = await loadDeliverySession(sessionId);
  if (!session) return 'no-session';
  if (session.status === 'failed') return 'unreachable';
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
    console.warn('[session-lifecycle] no actor for follow-up delivery', {
      sessionId,
    });
    return 'pending';
  }
  await clearChannelPrompter(command, session.accountId);
  const sendPrompt = createPromptSender(command, session, userId, idempotencyKey, beforeSend);

  void generateSessionTitleFromFirstPrompt({
    sessionId,
    projectId: session.projectId,
    accountId: session.accountId,
    userId,
    firstPromptText: command.text,
  });

  const wokeFrom =
    sessionTransitionLeaves('wake', session.status) && (await transitionSession('wake', sessionId, { error: null }))
      ? session.status
      : null;
  const outcome = await deliverAfterWake({
    command,
    session,
    sessionId,
    userId,
    awakeEarly,
    sendPrompt,
    beforeSend,
    tl,
  });
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

async function clearChannelPrompter(command: ContinueSessionCommand, accountId: string) {
  const channelPrompter = channelPrompterForOnBehalfOf({
    source: command.source,
    userId: command.userId ?? null,
    slackRequiresUserIdentity: config.SLACK_REQUIRE_USER_IDENTITY !== false,
    teamsRequiresUserIdentity: config.TEAMS_REQUIRE_USER_IDENTITY !== false,
  });
  if (channelPrompter !== undefined) {
    await clearSessionOnBehalfOfForPrompt({
      accountId,
      sessionId: command.sessionId,
      prompterUserId: channelPrompter,
    });
  }
}

function createPromptSender(
  command: ContinueSessionCommand,
  session: NonNullable<Awaited<ReturnType<typeof loadDeliverySession>>>,
  userId: string,
  idempotencyKey: string,
  beforeSend?: () => Promise<void>,
): (externalId: string, opencodeSessionId: string) => Promise<SendOutcome> {
  const { sessionId, text } = command;
  const sessionMeta = (session.metadata ?? {}) as LegacyInlineAttachmentRepairMetadata;
  const pendingAttachmentNames = sessionMeta.pending_prompt?.attachment_names;
  const shouldRepairLegacyInlineAttachments =
    command.isPendingFirstPrompt !== true &&
    Array.isArray(pendingAttachmentNames) &&
    pendingAttachmentNames.length > 0 &&
    typeof sessionMeta.legacy_inline_attachments_repaired_at !== 'string';
  const repairLegacyBeforeDelivery = createLegacyRepair(command, userId, shouldRepairLegacyInlineAttachments);
  return async (externalId: string, opencodeSessionId: string): Promise<SendOutcome> => {
    await repairLegacyBeforeDelivery(externalId, opencodeSessionId);
    await beforeSend?.();
    const delivery = await postPrompt(externalId, opencodeSessionId, text, userId, sessionId, idempotencyKey, {
      parts: command.parts,
      overrides: command.overrides,
      wireMessageId: command.wireMessageId,
      materializationKey: command.materializationKey,
      attachmentProjectId: resolveFeatureFlag(session.projectMetadata, 'session_transcript_history')
        ? session.projectId
        : undefined,
      accountId: session.accountId,
      projectId: session.projectId,
    });
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
      await lifecycleStore.markLegacyInlineAttachmentsRepaired(sessionId);
    }
    if (delivery === 'unreachable') return 'unreachable';
    return delivery !== 'failed';
  };
}

async function loadDeliverySession(sessionId: string) {
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
      projectMetadata: sql<Record<
        string,
        unknown
      > | null>`(SELECT p.metadata FROM kortix.projects p WHERE p.project_id = "kortix"."project_sessions"."project_id")`,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  return session;
}

function createLegacyRepair(
  command: ContinueSessionCommand,
  userId: string,
  shouldRepairLegacyInlineAttachments: boolean,
) {
  const { sessionId } = command;
  const legacyRepairByExternalId = new Map<string, Promise<void>>();
  const repairLegacyBeforeDelivery = (externalId: string, opencodeSessionId: string): Promise<void> => {
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
  return repairLegacyBeforeDelivery;
}
