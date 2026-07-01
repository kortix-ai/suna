import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, projects } from '@kortix/db';
import { sharedDb as db } from '../../shared/effect';
import { withProjectGitAuth } from '../../projects/lib/git';
import { listRepoFiles, loadProjectConfig } from '../../projects/git';

// Per-channel agent + model selection. A Slack channel is bound to a project
// (chat_channel_bindings); these helpers read/write the optional agent + model
// overrides on that binding. A session started from the channel inherits them
// (see session.ts) — null means "use the project/platform default".

export interface ChannelSelection {
  projectId: string;
  agentName: string | null;
  opencodeModel: string | null;
  conversationPolicy: string | null;
}

export interface ChannelCtx {
  teamId: string;
  channelId: string;
}

/** The channel's bound project + its agent/model overrides, or null if unbound. */
export async function currentChannelSelection(ctx: ChannelCtx): Promise<ChannelSelection | null> {
  if (!ctx.channelId) return null;
  let binding: { projectId: string | null; agentName: string | null; opencodeModel: string | null; conversationPolicy: string | null } | undefined;
  try {
    [binding] = await db
      .select({
        projectId: chatChannelBindings.projectId,
        agentName: chatChannelBindings.agentName,
        opencodeModel: chatChannelBindings.opencodeModel,
        conversationPolicy: chatChannelBindings.conversationPolicy,
      })
      .from(chatChannelBindings)
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, ctx.teamId),
        eq(chatChannelBindings.channelId, ctx.channelId),
      ))
      .limit(1);
  } catch (err) {
    if (!isMissingSelectionColumnError(err)) throw err;
    console.warn('[slack-selection] optional channel override columns missing; falling back to project-only routing');
    const projectId = await currentChannelProjectId(ctx);
    return projectId ? { projectId, agentName: null, opencodeModel: null, conversationPolicy: null } : null;
  }
  if (!binding?.projectId) return null;
  return {
    projectId: binding.projectId,
    agentName: binding.agentName ?? null,
    opencodeModel: binding.opencodeModel ?? null,
    conversationPolicy: binding.conversationPolicy ?? null,
  };
}

export async function setChannelConversationPolicy(ctx: ChannelCtx, conversationPolicy: string): Promise<boolean> {
  if (!ctx.channelId) return false;
  try {
    const rows = await db
      .update(chatChannelBindings)
      .set({ conversationPolicy })
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, ctx.teamId),
        eq(chatChannelBindings.channelId, ctx.channelId),
      ))
      .returning({ id: chatChannelBindings.bindingId });
    return rows.length > 0;
  } catch (err) {
    if (!isMissingSelectionColumnError(err)) throw err;
    console.warn('[slack-selection] conversation policy column missing; ignoring policy update');
    return false;
  }
}

/**
 * Update the channel binding's agent (null clears the override → 'default').
 * Returns false when the channel has no binding to update — the caller tells
 * the user to bind a project first.
 */
export async function setChannelAgent(ctx: ChannelCtx, agentName: string | null): Promise<boolean> {
  if (!ctx.channelId) return false;
  try {
    const rows = await db
      .update(chatChannelBindings)
      .set({ agentName })
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, ctx.teamId),
        eq(chatChannelBindings.channelId, ctx.channelId),
      ))
      .returning({ id: chatChannelBindings.bindingId });
    return rows.length > 0;
  } catch (err) {
    if (!isMissingSelectionColumnError(err)) throw err;
    console.warn('[slack-selection] agent override column missing; ignoring channel override update');
    return false;
  }
}

/** Update the channel binding's model (null clears → project/platform default). */
export async function setChannelModel(ctx: ChannelCtx, opencodeModel: string | null): Promise<boolean> {
  if (!ctx.channelId) return false;
  try {
    const rows = await db
      .update(chatChannelBindings)
      .set({ opencodeModel })
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, ctx.teamId),
        eq(chatChannelBindings.channelId, ctx.channelId),
      ))
      .returning({ id: chatChannelBindings.bindingId });
    return rows.length > 0;
  } catch (err) {
    if (!isMissingSelectionColumnError(err)) throw err;
    console.warn('[slack-selection] model override column missing; ignoring channel override update');
    return false;
  }
}

async function currentChannelProjectId(ctx: ChannelCtx): Promise<string | null> {
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ))
    .limit(1);
  return binding?.projectId ?? null;
}

function isMissingSelectionColumnError(err: unknown): boolean {
  const parts = [
    (err as any)?.message,
    (err as any)?.cause?.message,
    (err as any)?.cause?.cause?.message,
  ].filter(Boolean).join('\n');
  return (
    parts.includes('column "agent_name" does not exist') ||
    parts.includes('column "opencode_model" does not exist') ||
    parts.includes('column "conversation_policy" does not exist')
  );
}

export interface ProjectAgent {
  name: string;
  description: string | null;
  mode: string | null;
}

/**
 * The project's launchable agents from the server-side config summary:
 * declarative `kortix.toml [[agents]]` for adopted projects, OpenCode markdown
 * discovery for legacy projects. Touches git, so callers must use the async
 * slash response path (response_url) to stay inside Slack's 3s window.
 */
export async function listProjectAgents(projectId: string): Promise<ProjectAgent[]> {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) return [];
  const gitProject = await withProjectGitAuth(row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, row.defaultBranch);
  } catch {
    // Repo unreachable — fall back to whatever loadProjectConfig can infer.
  }
  const config = await loadProjectConfig(gitProject, files);
  return config.agents.map((a) => ({
    name: a.name,
    description: a.description ?? null,
    mode: a.mode ?? null,
  }));
}

/**
 * A model id is shaped like a usable ref if it's a non-empty `provider/model`
 * pair (or `kortix/<id>`). Shape only — real servability is enforced separately
 * via `isModelServableForAccount` against the account's tier + connected keys.
 */
export function isValidModelId(s: string): boolean {
  const slash = s.indexOf('/');
  return slash > 0 && slash < s.length - 1 && !/\s/.test(s);
}
