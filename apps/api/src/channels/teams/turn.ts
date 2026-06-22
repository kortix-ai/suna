import { and, eq, lt, sql } from 'drizzle-orm';
import { chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { sessionWebUrl } from '../slack/util';
import type { StreamTaskChunk } from '../slack-api';
import { sendCard, sendTyping, updateCard } from '../teams-api';
import { saveTeamsServiceUrl } from '../install-store';
import { buildAnswerCard, buildFinalCard, buildPlanCard } from './cards';
import { STREAM_TTL_MS, STALE_AFTER_MS } from './app';
import type { TeamsActivity, TeamsChannelRef, TeamsConversationRef, TeamsLiveTurn } from './types';

const LIVE_PLAN_TITLE = 'Working on it…';

function refOf(handle: TeamsLiveTurn): TeamsConversationRef {
  return {
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
    tenantId: handle.tenantId,
  };
}

function rowToHandle(row: typeof chatTurnStreams.$inferSelect): TeamsLiveTurn {
  const ref = (row.channelRef ?? {}) as TeamsChannelRef;
  return {
    conversationId: row.channel,
    tenantId: row.teamId,
    serviceUrl: ref.serviceUrl ?? '',
    botId: ref.botId,
    fromId: ref.fromId,
    triggerActivityId: row.triggerTs,
    messageActivityId: row.messageTs ?? '',
    steps: (row.steps as StreamTaskChunk[]) ?? [],
    expiry: new Date(row.expiresAt).getTime(),
    finalized: row.finalized,
    projectId: row.projectId,
    sessionId: row.sessionId,
    originatingActivity: row.originatingEvent as TeamsActivity,
  };
}

export async function loadTurn(sessionId: string): Promise<TeamsLiveTurn | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select()
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  if (!row || !row.channelRef) return null;
  const expiry = new Date(row.expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    await deleteTurn(sessionId);
    return null;
  }
  return rowToHandle(row);
}

export async function saveTurn(handle: TeamsLiveTurn): Promise<void> {
  if (!handle.sessionId) return;
  const channelRef: TeamsChannelRef = {
    platform: 'teams',
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
  };
  const values = {
    sessionId: handle.sessionId,
    projectId: handle.projectId,
    teamId: handle.tenantId,
    channel: handle.conversationId,
    triggerTs: handle.triggerActivityId,
    messageTs: handle.messageActivityId || null,
    finalized: handle.finalized,
    steps: handle.steps,
    originatingEvent: handle.originatingActivity as unknown,
    channelRef: channelRef as unknown,
    expiresAt: new Date(handle.expiry),
    updatedAt: new Date(),
  };
  await db
    .insert(chatTurnStreams)
    .values(values as typeof chatTurnStreams.$inferInsert)
    .onConflictDoUpdate({ target: chatTurnStreams.sessionId, set: values as Partial<typeof chatTurnStreams.$inferInsert> });
}

export async function deleteTurn(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await db.delete(chatTurnStreams).where(eq(chatTurnStreams.sessionId, sessionId));
}

export async function claimFinalize(sessionId: string): Promise<boolean> {
  const rows = await db
    .update(chatTurnStreams)
    .set({ finalized: true, updatedAt: new Date() })
    .where(and(eq(chatTurnStreams.sessionId, sessionId), eq(chatTurnStreams.finalized, false)))
    .returning({ sessionId: chatTurnStreams.sessionId });
  return rows.length > 0;
}

export async function startTurn(
  projectId: string,
  tenantId: string,
  activity: TeamsActivity,
): Promise<TeamsLiveTurn | null> {
  const serviceUrl = activity.serviceUrl;
  const conversationId = activity.conversation?.id;
  if (!serviceUrl || !conversationId || !activity.id) return null;

  const ref: TeamsConversationRef = {
    serviceUrl,
    conversationId,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId,
  };
  await sendTyping(ref);

  return {
    conversationId,
    tenantId,
    serviceUrl,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    triggerActivityId: activity.id,
    messageActivityId: '',
    steps: [],
    expiry: Date.now() + STREAM_TTL_MS,
    finalized: false,
    projectId,
    sessionId: '',
    originatingActivity: activity,
  };
}

async function repaintPlan(handle: TeamsLiveTurn): Promise<void> {
  if (!handle.messageActivityId) return;
  await updateCard(refOf(handle), handle.messageActivityId, buildPlanCard(LIVE_PLAN_TITLE, handle.steps));
}

export async function relayTurnStep(
  sessionId: string,
  title: string,
  opts: {
    detail?: string;
    outputForPrev?: string;
    sourcesForPrev?: Array<{ url: string; text: string }>;
  } = {},
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) {
    if (!handle) {
      console.warn('[teams-webhook] turn-stream step dropped — no open turn for session', {
        sessionId,
        title: title.slice(0, 80),
      });
    }
    return false;
  }

  if (!handle.messageActivityId) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = opts.detail.slice(0, 500);
    const activityId = await sendCard(refOf(handle), buildPlanCard(LIVE_PLAN_TITLE, [firstStep]));
    if (!activityId) return false;
    handle.messageActivityId = activityId;
    handle.steps = [firstStep];
    handle.expiry = Date.now() + STREAM_TTL_MS;
    await saveTurn(handle);
    return true;
  }

  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    if (opts.outputForPrev) last.output = opts.outputForPrev.slice(0, 500);
    if (opts.sourcesForPrev && opts.sourcesForPrev.length > 0) {
      last.sources = opts.sourcesForPrev.slice(0, 8).map((s) => ({
        type: 'url',
        url: s.url,
        text: s.text.slice(0, 80),
      }));
    }
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  if (opts.detail) next.details = opts.detail.slice(0, 500);
  handle.steps.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await repaintPlan(handle);
  await saveTurn(handle);
  return true;
}

export async function relayTurnAnswer(sessionId: string, text: string): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(handle, { answer: text });
  await deleteTurn(sessionId);
  return true;
}

export async function relayTurnEnd(sessionId: string, status: 'idle' | 'error' = 'idle'): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(
    handle,
    status === 'error' ? { error: '_The run hit an error — open the session for details._' } : {},
  );
  await deleteTurn(sessionId);
  return true;
}

export async function finalizeTurn(
  handle: TeamsLiveTurn,
  opts: { answer?: string; error?: string },
): Promise<void> {
  if (handle.finalized && handle.messageActivityId === '' && !opts.answer && !opts.error) return;
  const hasContent = Boolean(opts.answer || opts.error);
  const body = (opts.answer ?? opts.error ?? '').slice(0, 11000);
  const title = opts.error ? 'Run failed' : 'Task complete';
  const sessionUrl =
    handle.projectId && handle.sessionId
      ? sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId)
      : undefined;

  try {
    if (handle.messageActivityId && handle.steps.length > 0) {
      const last = handle.steps[handle.steps.length - 1];
      if (last && last.status === 'in_progress') last.status = opts.error ? 'error' : 'complete';
      await updateCard(
        refOf(handle),
        handle.messageActivityId,
        buildFinalCard({ title, steps: handle.steps, body, sessionUrl }),
      );
    } else if (hasContent) {
      await sendCard(refOf(handle), buildAnswerCard(body, sessionUrl));
    }
  } catch (err) {
    console.warn('[teams-webhook] finalize render failed (turn still closed)', {
      sessionId: handle.sessionId,
      err: (err as Error)?.message,
    });
  }
}

export function buildTeamsTurnEnv(tenantId: string, activity: TeamsActivity): Record<string, string> {
  const env: Record<string, string> = {};
  if (tenantId) env.MS_TEAMS_TENANT_ID = tenantId;
  if (activity.conversation?.id) env.MS_TEAMS_CONVERSATION_ID = activity.conversation.id;
  if (activity.serviceUrl) env.MS_TEAMS_SERVICE_URL = activity.serviceUrl;
  if (activity.from?.id) env.MS_TEAMS_USER_ID = activity.from.id;
  return env;
}

export async function persistServiceUrl(projectId: string, serviceUrl?: string): Promise<void> {
  if (serviceUrl) await saveTeamsServiceUrl(projectId, serviceUrl).catch(() => {});
}

setInterval(() => {
  void (async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_AFTER_MS);
      const stale = await db
        .select()
        .from(chatTurnStreams)
        .where(
          and(
            eq(chatTurnStreams.finalized, false),
            lt(chatTurnStreams.updatedAt, cutoff),
            sql`${chatTurnStreams.channelRef}->>'platform' = 'teams'`,
          ),
        )
        .limit(50);
      for (const row of stale) {
        if (!(await claimFinalize(row.sessionId))) continue;
        await finalizeTurn(rowToHandle(row), { error: '_This run ended without a reply._' });
        await deleteTurn(row.sessionId);
      }
    } catch (err) {
      console.warn('[teams-webhook] gc tick failed', err);
    }
  })();
}, 5 * 60 * 1000).unref();
