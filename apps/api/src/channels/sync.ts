import { and, eq, notInArray, sql } from 'drizzle-orm';
import { chatChannelBindings, type Project } from '@kortix/db';
import { db } from '../shared/db';
import { loadProjectChannels } from './load';
import { loadSlackInstall } from './install-store';
import type { ChannelPlatform } from './manifest';

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
  skipped: { slug: string; reason: string }[];
}

export async function syncProjectChannelBindings(project: Project): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, removed: 0, skipped: [] };

  const { specs } = await loadProjectChannels({
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
  });

  const platforms = new Set<ChannelPlatform>(specs.map((s) => s.platform));
  const workspaces = await loadWorkspaceIds(project.projectId, platforms);

  const idBound = specs.filter((spec) => {
    if (!spec.channelId) {
      result.skipped.push({ slug: spec.slug, reason: 'channel_name not yet resolved' });
      return false;
    }
    if (!workspaces.has(spec.platform)) {
      result.skipped.push({
        slug: spec.slug,
        reason: `${spec.platform} is not connected on this project — open Channels in the sidebar`,
      });
      return false;
    }
    return true;
  });

  if (idBound.length === 0) {
    const removed = await db
      .delete(chatChannelBindings)
      .where(eq(chatChannelBindings.projectId, project.projectId))
      .returning({ id: chatChannelBindings.bindingId });
    result.removed = removed.length;
    return result;
  }

  const survivingSlugs = idBound.map((s) => s.slug);
  const removed = await db
    .delete(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.projectId, project.projectId),
        notInArray(chatChannelBindings.slug, survivingSlugs),
      ),
    )
    .returning({ id: chatChannelBindings.bindingId });
  result.removed = removed.length;

  for (const spec of idBound) {
    const workspaceId = workspaces.get(spec.platform)!;
    const ret = await db
      .insert(chatChannelBindings)
      .values({
        projectId: project.projectId,
        slug: spec.slug,
        platform: spec.platform,
        workspaceId,
        channelId: spec.channelId!,
        channelName: spec.channelName,
      })
      .onConflictDoUpdate({
        target: [chatChannelBindings.projectId, chatChannelBindings.slug],
        set: {
          platform: spec.platform,
          workspaceId,
          channelId: spec.channelId!,
          channelName: spec.channelName,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: chatChannelBindings.bindingId,
        created: sql<boolean>`(xmax = 0)`,
      });
    const row = ret[0];
    if (row?.created) result.inserted += 1;
    else result.updated += 1;
  }

  return result;
}

export async function dropProjectChannelBindings(projectId: string) {
  await db.delete(chatChannelBindings).where(eq(chatChannelBindings.projectId, projectId));
}

async function loadWorkspaceIds(
  projectId: string,
  platforms: Set<ChannelPlatform>,
): Promise<Map<ChannelPlatform, string>> {
  const map = new Map<ChannelPlatform, string>();
  if (platforms.has('slack')) {
    const install = await loadSlackInstall(projectId);
    if (install) map.set('slack', install.workspaceId);
  }
  return map;
}
