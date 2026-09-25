import { chatChannelBindings, chatInstalls, chatThreads, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ChannelCtx } from '../slack/selection';

const PLATFORM = 'teams';

export function teamsChannelCtx(tenantId: string, conversationId: string): ChannelCtx {
  return { teamId: tenantId, channelId: conversationId, platform: PLATFORM };
}

export async function listTenantProjects(
  tenantId: string,
): Promise<Array<{ projectId: string; name: string }>> {
  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.workspaceId, tenantId)));
  if (installs.length === 0) return [];
  const ids = installs.map((i) => i.projectId);
  const rows = await db
    .select({ projectId: projects.projectId, name: projects.name })
    .from(projects);
  const byId = new Map(rows.map((r) => [r.projectId, r.name]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({ projectId: id, name: byId.get(id) ?? id }));
}

export async function resolveConversationProject(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, PLATFORM),
        eq(chatChannelBindings.workspaceId, tenantId),
        eq(chatChannelBindings.channelId, conversationId),
      ),
    )
    .limit(1);
  if (binding?.projectId) {
    const [installed] = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, PLATFORM),
          eq(chatInstalls.workspaceId, tenantId),
          eq(chatInstalls.projectId, binding.projectId),
        ),
      )
      .limit(1);
    if (installed) return binding.projectId;
  }

  const [install] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.workspaceId, tenantId)))
    .limit(1);
  return install?.projectId ?? null;
}

export type ConversationProjectResolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; projects: Array<{ projectId: string; name: string }> };

/**
 * Which project a conversation runs, distinguishing "a binding or a single
 * install decides it" from "several projects are installed for this tenant and
 * nothing is bound yet" — the case where Slack posts a project picker instead
 * of silently routing to the first install.
 */
export async function resolveConversationProjectDetailed(
  tenantId: string,
  conversationId: string,
): Promise<ConversationProjectResolution> {
  const bound = await resolveBoundProject(tenantId, conversationId);
  if (bound) return { kind: 'project', projectId: bound };

  const tenantProjects = await listTenantProjects(tenantId);
  if (tenantProjects.length === 0) return { kind: 'none' };
  if (tenantProjects.length === 1) return { kind: 'project', projectId: tenantProjects[0].projectId };
  return { kind: 'ambiguous', projects: tenantProjects };
}

/** Just the explicitly-bound project (installed), if any. */
async function resolveBoundProject(tenantId: string, conversationId: string): Promise<string | null> {
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, PLATFORM),
        eq(chatChannelBindings.workspaceId, tenantId),
        eq(chatChannelBindings.channelId, conversationId),
      ),
    )
    .limit(1);
  if (!binding?.projectId) return null;
  const [installed] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, PLATFORM),
        eq(chatInstalls.workspaceId, tenantId),
        eq(chatInstalls.projectId, binding.projectId),
      ),
    )
    .limit(1);
  return installed ? binding.projectId : null;
}

/**
 * One write per distinct (conversation, name, type) per process.
 *
 * `ensureTeamsConversationBinding` now runs on EVERY inbound message so a
 * conversation's display name is backfilled rather than captured only at
 * session creation — the dev tenant had channel bindings showing a raw
 * `19:…@thread.tacv2;messageid=…` in the bindings table because they were
 * bound before the name was being read off the activity. An upsert per message
 * would be a write per message; this is the same shape as
 * `persistServiceUrl`'s cache in teams/turn.ts, and a restart simply writes
 * each one once more.
 */
const describedBindings = new Map<string, string>();

export function resetTeamsBindingCacheForTest(): void {
  describedBindings.clear();
}

export async function ensureTeamsConversationBinding(input: {
  tenantId: string;
  conversationId: string;
  projectId: string;
  channelName?: string | null;
  channelType?: string | null;
}): Promise<boolean> {
  const cacheKey = `${input.tenantId}:${input.conversationId}`;
  const described = `${input.projectId}|${input.channelName ?? ''}|${input.channelType ?? ''}`;
  if (describedBindings.get(cacheKey) === described) return true;
  const [installed] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, PLATFORM),
        eq(chatInstalls.workspaceId, input.tenantId),
        eq(chatInstalls.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!installed) return false;

  await db
    .insert(chatChannelBindings)
    .values({
      platform: PLATFORM,
      workspaceId: input.tenantId,
      channelId: input.conversationId,
      projectId: input.projectId,
      channelName: input.channelName ?? null,
      channelType: input.channelType ?? null,
    })
    .onConflictDoUpdate({
      target: [
        chatChannelBindings.platform,
        chatChannelBindings.workspaceId,
        chatChannelBindings.channelId,
      ],
      set: {
        projectId: input.projectId,
        ...(input.channelName ? { channelName: input.channelName } : {}),
        ...(input.channelType ? { channelType: input.channelType } : {}),
      },
    });
  describedBindings.set(cacheKey, described);
  return true;
}

export interface TeamsConversationSession {
  sessionId: string;
  status: string | null;
  agentName: string | null;
  createdAt: Date | null;
}

/**
 * The Kortix session this conversation is running, if any.
 *
 * A Teams conversation holds exactly one at a time — `chat_threads` is keyed on
 * the thread — which is what lets `/stop` and `/status` name a run without the
 * user quoting an id. The session row may be gone while the thread row remains
 * (a deleted session), so the join is left as two reads and the caller is told
 * the id even when the row behind it has vanished.
 */
export async function conversationSession(
  tenantId: string,
  conversationId: string,
  /** Only a session of this project counts (a per-project bot's scope). */
  projectId?: string,
): Promise<TeamsConversationSession | null> {
  const [thread] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, PLATFORM),
        eq(chatThreads.workspaceId, tenantId),
        eq(chatThreads.threadId, conversationId),
        projectId ? eq(chatThreads.projectId, projectId) : undefined,
      ),
    )
    .limit(1);
  if (!thread?.sessionId) return null;
  const [row] = await db
    .select({
      status: projectSessions.status,
      agentName: projectSessions.agentName,
      createdAt: projectSessions.createdAt,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, thread.sessionId))
    .limit(1);
  return {
    sessionId: thread.sessionId,
    status: row?.status ?? null,
    agentName: row?.agentName ?? null,
    createdAt: row?.createdAt ?? null,
  };
}
