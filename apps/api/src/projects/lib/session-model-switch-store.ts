import { auditEvents, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { pickedModelMetadata } from '../../llm-gateway/resolution/session-model-fallback';
import { buildContinueSessionCommandValues } from '../session-lifecycle/enqueue-commands';
import { modelChangeNeedsLivePush } from './session-model-change';
import { mintWireMessageId } from '../wire-message-id';

/** Serialize switches per session, committing the pin and continuation in one transaction. */
export async function storeSessionModelSwitch(input: {
  projectId: string; accountId: string; sessionId: string; actorUserId: string;
  actorSessionId: string | null; model: string; prompt?: string; key: string;
  push?: (model: string) => Promise<{ applied: boolean; reason?: string }>;
}) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(projectSessions)
      .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId))).for('update');
    if (!session) throw new Error('Session disappeared before model switch');
    const key = `model-switch:${input.sessionId}:${input.key}`;
    const [existing] = await tx.select().from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, key));
    if (existing) {
      const audit = existing.payload.modelSwitch;
      if (!audit || typeof audit !== 'object' || Array.isArray(audit) ||
          !('to' in audit) || audit.to !== input.model || !('prompt' in audit) || audit.prompt !== (input.prompt ?? null) ||
          !('actorSessionId' in audit) || audit.actorSessionId !== input.actorSessionId || existing.actorUserId !== input.actorUserId) {
        return { kind: 'conflict' } as const;
      }
      return { kind: 'stored', promptId: existing.commandId, model: typeof session.metadata?.model === 'string' ? session.metadata.model : input.model, needsPush: false, deduped: true } as const;
    }
    // Bound unattended self-switch loops. Human model writes do not consume this budget.
    if (input.actorSessionId === input.sessionId) {
      const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(sessionLifecycleCommands)
        .where(and(eq(sessionLifecycleCommands.sessionId, input.sessionId),
          sql`${sessionLifecycleCommands.payload}->'modelSwitch'->>'actorSessionId' = ${input.sessionId}`,
          sql`${sessionLifecycleCommands.createdAt} > now() - interval '1 hour'`));
      if ((count?.count ?? 0) >= 3) return { kind: 'limited' } as const;
    }
    const metadata = session.metadata ?? {};
    const values = buildContinueSessionCommandValues({
      source: 'cli', projectId: input.projectId, accountId: input.accountId,
      sessionId: input.sessionId, actorUserId: input.actorUserId, text: input.prompt ?? '',
      idempotencyKey: key, clientMessageId: input.key,
      wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
      remintOnDelivery: true, placement: 'composer', delivery: 'queue',
      parts: input.prompt ? [{ type: 'text', text: input.prompt }] : [],
      overrides: { model: { providerID: 'kortix', modelID: input.model.replace(/^kortix\//, '') } },
      bindTurnIdentity: input.actorSessionId === null,
    });
    const [row] = await tx.insert(sessionLifecycleCommands).values({ ...values, ...(!input.prompt ? { status: 'succeeded', completedAt: new Date() } : {}), payload: {
      ...values.payload,
      modelSwitch: { from: metadata.model ?? null, to: input.model,
        actorSessionId: input.actorSessionId, prompt: input.prompt ?? null, at: new Date().toISOString() },
    } }).returning();
    if (!row) throw new Error('Model switch continuation was not stored');
    await tx.insert(auditEvents).values({
      accountId: input.accountId, projectId: input.projectId, sessionId: input.sessionId,
      actorUserId: input.actorUserId, actorType: input.actorSessionId ? 'agent_session' : 'user',
      agentId: input.actorSessionId, action: 'session.model.changed', resourceType: 'session',
      resourceId: input.sessionId, outcome: 'success', source: 'api',
      inputSummary: { from: metadata.model ?? null, to: input.model,
        prompt: input.prompt ?? null, prompt_id: row.commandId, actor_session_id: input.actorSessionId },
    });
    await tx.update(projectSessions).set({ metadata: { ...pickedModelMetadata(metadata, input.model), model_switches: [...(Array.isArray(metadata.model_switches) ? metadata.model_switches.slice(-99) : []), { id: row.commandId, from: metadata.model ?? null, to: input.model, actor_session_id: input.actorSessionId, prompt: input.prompt ?? null, at: row.createdAt.toISOString() }] }, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, input.sessionId));
    const needsPush = modelChangeNeedsLivePush({ current: typeof metadata.model === 'string' ? metadata.model : null, next: input.model, status: session.status });
    // Keep the session lock until live reconfiguration finishes: another writer cannot push an older pin last.
    const push = needsPush && input.push ? await input.push(input.model).catch(() => ({ applied: false, reason: 'live reconfiguration failed' })) : undefined;
    return { kind: 'stored', promptId: row.commandId, model: input.model, needsPush, push, deduped: false } as const;
  });
}
