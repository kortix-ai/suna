import type { ApiClient } from '../api/client.ts';
export async function installationProven(client: ApiClient, itemId: string, ctx: { projectId: string }, controller: AbortController): Promise<boolean> {
  try {
    const item = await client.get<{
      name: string;
      type: string;
      files: Array<{ target: string }>;
    }>(`/marketplace/items/${encodeURIComponent(itemId)}`);
    const targets = item.files.map((f) =>
      f.target.replace(/^@(skills|agents|tools|commands)\//, '$1/'),
    );
    const conventional =
      targets.length > 0 &&
      targets.every(
        (t) =>
          !t.startsWith('/') && !t.includes('..') && !t.includes('@') && !t.includes('~'),
      );
    if (item.type === 'registry:skill' && conventional) {
      const detail = await client.get<{ config: { skills: Array<{ name: string }> } }>(
        `/projects/${ctx.projectId}/detail`,
      );
      let filesPresent = true;
      for (const target of targets) {
        const files = await client.get<Array<{ path: string; type: string }>>(
          `/projects/${ctx.projectId}/files?path=${encodeURIComponent(target)}`,
        );
        if (!files.some((file) => file.path === target && file.type === 'file')) {
          filesPresent = false;
          break;
        }
      }
      if (detail.config.skills.some((skill) => skill.name === item.name) && filesPresent)
        return true;
    }
  } catch (error) {
    if (controller.signal.aborted) throw error;
    // Completion is not proof: unavailable catalog/files require review.
  }
  return false;
}
