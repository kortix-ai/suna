import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, projects, type Project } from '@kortix/db';
import { db } from '../shared/db';
import { loadProjectChannels } from './load';
import type { ChannelPlatform, ChannelSpec } from './manifest';

export interface ResolvedChannel {
  project: Project;
  spec: ChannelSpec;
}

/**
 * Map an incoming Slack event (workspace_id from the event payload) to the
 * project that owns this Slack install. One project per (platform, workspace_id)
 * is the contract enforced by chat_channel_bindings.
 */
export async function resolveChannel(
  platform: ChannelPlatform,
  workspaceId: string,
): Promise<ResolvedChannel | null> {
  const [binding] = await db
    .select()
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, platform),
        eq(chatChannelBindings.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!binding) return null;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.projectId, binding.projectId), eq(projects.status, 'active')))
    .limit(1);
  if (!project) return null;

  const { specs } = await loadProjectChannels({
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
  });
  const spec = specs.find((s) => s.platform === platform);
  if (!spec || !spec.enabled) return null;

  return { project, spec };
}
