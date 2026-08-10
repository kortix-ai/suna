import { chatChannelBindings, chatInstalls, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ChannelCtx } from '../slack/selection';

const PLATFORM = 'teams';

export function teamsChannelCtx(tenantId: string, conversationId: string): ChannelCtx {
  return { teamId: tenantId, channelId: conversationId, platform: PLATFORM };
}

export async function listTenantWorkspaces(
  tenantId: string,
): Promise<Array<{ workspaceId: string; name: string }>> {
  const installs = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.platformWorkspaceId, tenantId)));
  if (installs.length === 0) return [];
  const ids = installs.map((i) => i.workspaceId);
  const rows = await db
    .select({ workspaceId: projects.workspaceId, name: projects.name })
    .from(projects);
  const byId = new Map(rows.map((r) => [r.workspaceId, r.name]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({ workspaceId: id, name: byId.get(id) ?? id }));
}

export async function resolveConversationWorkspace(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  const [binding] = await db
    .select({ workspaceId: chatChannelBindings.workspaceId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, PLATFORM),
        eq(chatChannelBindings.platformWorkspaceId, tenantId),
        eq(chatChannelBindings.channelId, conversationId),
      ),
    )
    .limit(1);
  if (binding?.workspaceId) {
    const [installed] = await db
      .select({ workspaceId: chatInstalls.workspaceId })
      .from(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, PLATFORM),
          eq(chatInstalls.platformWorkspaceId, tenantId),
          eq(chatInstalls.workspaceId, binding.workspaceId),
        ),
      )
      .limit(1);
    if (installed) return binding.workspaceId;
  }

  const [install] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.platformWorkspaceId, tenantId)))
    .limit(1);
  return install?.workspaceId ?? null;
}

export async function ensureTeamsConversationBinding(input: {
  tenantId: string;
  conversationId: string;
  workspaceId: string;
  channelName?: string | null;
  channelType?: string | null;
}): Promise<boolean> {
  const [installed] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, PLATFORM),
        eq(chatInstalls.platformWorkspaceId, input.tenantId),
        eq(chatInstalls.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!installed) return false;

  await db
    .insert(chatChannelBindings)
    .values({
      platform: PLATFORM,
      platformWorkspaceId: input.tenantId,
      channelId: input.conversationId,
      workspaceId: input.workspaceId,
      channelName: input.channelName ?? null,
      channelType: input.channelType ?? null,
    })
    .onConflictDoUpdate({
      target: [
        chatChannelBindings.platform,
        chatChannelBindings.platformWorkspaceId,
        chatChannelBindings.channelId,
      ],
      set: { workspaceId: input.workspaceId },
    });
  return true;
}

export async function setConversationWorkspace(input: {
  tenantId: string;
  conversationId: string;
  workspaceId: string;
}): Promise<boolean> {
  return ensureTeamsConversationBinding(input);
}
