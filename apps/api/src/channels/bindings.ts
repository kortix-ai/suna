import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, projects, type Project } from '@kortix/db';
import { db } from '../shared/db';
import { loadProjectChannels } from './load';
import type { ChannelPlatform, ChannelSpec } from './manifest';

export interface ResolvedChannel {
  project: Project;
  spec: ChannelSpec;
}

export async function resolveChannel(
  platform: ChannelPlatform,
  workspaceId: string,
  channelId: string,
): Promise<ResolvedChannel | null> {
  const rawChannelId = stripAdapterPrefix(platform, channelId);
  const [binding] = await db
    .select()
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, platform),
        eq(chatChannelBindings.workspaceId, workspaceId),
        eq(chatChannelBindings.channelId, rawChannelId),
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
  const spec = specs.find((s) => s.slug === binding.slug);
  if (!spec || !spec.enabled) return null;
  if (spec.platform !== platform) return null;
  if (spec.channelId && spec.channelId !== rawChannelId) return null;

  return { project, spec };
}

function stripAdapterPrefix(platform: ChannelPlatform, value: string): string {
  const prefix = `${platform}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
