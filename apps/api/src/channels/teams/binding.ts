import { chatChannelBindings, chatInstalls, projects } from '@kortix/db';
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

export async function ensureTeamsConversationBinding(input: {
  tenantId: string;
  conversationId: string;
  projectId: string;
  channelName?: string | null;
  channelType?: string | null;
}): Promise<boolean> {
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
  return true;
}

export async function setConversationProject(input: {
  tenantId: string;
  conversationId: string;
  projectId: string;
}): Promise<boolean> {
  return ensureTeamsConversationBinding(input);
}
