import { config } from '../../lib/config';
import { repoDisplayLabel, repoPreviewImages } from '../repo-preview';
import type { ProjectRow } from './cards';

/** How many projects a card lists. */
export const MAX_PROJECT_ROWS = 8;

export function projectWebUrl(projectId: string): string {
  return `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${projectId}`;
}

/** How long a card waits for a first preview check. Teams cards post asynchronously. */
export const PREVIEW_WAIT_MS = 2_500;

/**
 * Tenant projects as card rows, as Slack's project carousel shows them: the
 * repository as a person reads it, and its preview only when it loads.
 */
export async function projectRows(
  projects: ReadonlyArray<{ projectId: string; name: string; repoUrl?: string | null }>,
  currentProjectId?: string | null,
): Promise<ProjectRow[]> {
  const shown = projects.slice(0, MAX_PROJECT_ROWS);
  const images = await repoPreviewImages(shown.map((p) => p.repoUrl), { waitMs: PREVIEW_WAIT_MS });
  return shown.map((p) => ({
    projectId: p.projectId,
    name: p.name,
    repo: repoDisplayLabel(p.repoUrl),
    imageUrl: p.repoUrl ? images.get(p.repoUrl) ?? null : null,
    url: projectWebUrl(p.projectId),
    current: p.projectId === currentProjectId,
  }));
}
