import { SessionCreateInputSchema } from '@kortix/api-contract';
import {
  projectSessionConnectorBindings,
  projectSessionGrants,
  projectSessionRuntimeContexts,
  projectSessions,
  sessionLifecycleCommands,
  sessionProviderSecretPools,
} from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ProjectSessionRow } from './serializers';
import type { SessionCreateInput, SessionCreatePlan } from './session-create-plan';

/**
 * The session's insert transaction, hoisted out of `createProjectSession`
 * verbatim. Session, context and connection bindings land in one transaction:
 * nothing is visible and provisioning never starts when any child insert
 * fails.
 */
export async function insertSessionAndBindings(
  input: SessionCreateInput,
  plan: SessionCreatePlan,
): Promise<ProjectSessionRow> {
  const body = input.body;
  const {
    sessionId,
    accountId,
    projectId,
    baseRef,
    providerName,
    agentName,
    userId,
    visibility,
    origin,
    parentSession,
    initiator,
    secretsAllowlist,
    connectorBindingsConfigured,
    inheritUnbound,
    metadata,
    providerSecretPools,
    runtimeContext,
    connectorBindings,
    pendingPromptConversion,
    inheritedGrants,
  } = plan;
    return db.transaction(async (tx) => {
      const [row] = await tx
      .insert(projectSessions)
      .values({
        sessionId,
        accountId,
        projectId,
        branchName: sessionId,
        baseRef,
        sandboxProvider: providerName,
        sandboxId: sessionId,
        // Do not set opencodeSessionId during wrapper-session creation.
        // Runtime root discovery persists it only after OpenCode creates its root.
        agentName,
        status: 'provisioning',
        // Sessions are private to their creator by default; share via the
        // session-header control (visibility = project | restricted).
        createdBy: userId,
        visibility,
        origin,
        parentSessionId: parentSession?.sessionId ?? null,
        initiatorType: initiator.type,
        initiatorId: initiator.id,
        secretsAllowlist,
        labels: SessionCreateInputSchema.shape.labels.parse(body.labels) ?? [],
        connectorBindingsConfigured,
        connectorBindingsInheritUnbound: inheritUnbound,
        metadata,
        updatedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error('Session insert returned no row');
    if (input.createCommandId) {
      // Same transaction as the session row: a create command whose worker
      // dies after this commit is reclaimed WITH its session id, and
      // executeQueuedCreate returns this session instead of provisioning a
      // second one.
      await tx
        .update(sessionLifecycleCommands)
        .set({ sessionId, updatedAt: new Date() })
        .where(
          and(
            eq(sessionLifecycleCommands.commandId, input.createCommandId),
            eq(sessionLifecycleCommands.commandType, 'create_session'),
            isNull(sessionLifecycleCommands.sessionId),
          ),
        );
    }
    if (providerSecretPools && Object.keys(providerSecretPools).length > 0) {
      await tx.insert(sessionProviderSecretPools).values(
        Object.entries(providerSecretPools).map(([providerId, secretIds]) => ({ sessionId, providerId, secretIds })),
      );
    }
    if (runtimeContext !== undefined) {
        await tx
          .insert(projectSessionRuntimeContexts)
          .values({
            sessionId,
             context: runtimeContext,
             byteSize: new TextEncoder().encode(JSON.stringify(runtimeContext))
              .byteLength,
          })
          .returning({ sessionId: projectSessionRuntimeContexts.sessionId });
    }
      if (pendingPromptConversion?.rowValues) {
        // Same transaction as the session row: either the session exists WITH
        // its first prompt durable, or neither does. No conflict handling —
        // `sessionId` is fresh here, so the idempotency key cannot collide
        // without the projectSessions PK colliding first.
        const insertPrompt = tx
          .insert(sessionLifecycleCommands)
          .values(pendingPromptConversion.rowValues);
        // Only a handle prompt reads its payload back, for binding. A legacy
        // prompt can carry up to 12 MiB of data-URL parts it never needs again.
        if ((pendingPromptConversion.rowValues.payload.parts as Array<{ attachment_id?: string }> | undefined)?.some((part) => part.attachment_id)) {
          const [promptCommand] = await insertPrompt.returning({
            commandId: sessionLifecycleCommands.commandId,
            accountId: sessionLifecycleCommands.accountId,
            projectId: sessionLifecycleCommands.projectId,
            actorUserId: sessionLifecycleCommands.actorUserId,
            payload: sessionLifecycleCommands.payload,
          });
          if (promptCommand) {
            const { bindPromptAttachments } = await import('../prompt-attachments');
            await bindPromptAttachments(tx, promptCommand, input.attachmentSourceCommandId);
          }
        } else {
          await insertPrompt.returning({ commandId: sessionLifecycleCommands.commandId });
        }
      }
      if (connectorBindings.length > 0) {
        await tx
          .insert(projectSessionConnectorBindings)
          .values(
             connectorBindings.map((binding) => ({
              sessionId,
              accountId,
              projectId,
              connectorAlias: binding.alias,
              connectorId: binding.connectorId,
              connectionId: binding.connectionId,
              source: 'request' as const,
              createdBy: userId,
            })),
          )
          .returning({ sessionId: projectSessionConnectorBindings.sessionId });
      }
      if (inheritedGrants.length > 0) {
        await tx.insert(projectSessionGrants).values(
          inheritedGrants.map((g) => ({
            sessionId,
            principalType: g.principalType,
            principalId: g.principalId,
          })),
        );
      }
      return row;
    });
  }