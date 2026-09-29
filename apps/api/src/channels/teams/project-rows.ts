import { config } from '../../config';
import { repoLabel, repoOgImage } from '../slack/util';
import type { ProjectRow } from './cards';

/** How many projects a card lists. */
export const MAX_PROJECT_ROWS = 8;

export function projectWebUrl(projectId: string): string {
  return `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${projectId}`;
}

/** Tenant projects as card rows: repo label and preview image, as Slack's project carousel shows them. */
export function projectRows(
  projects: ReadonlyArray<{ projectId: string; name: string; repoUrl?: string | null }>,
  currentProjectId?: string | null,
): ProjectRow[] {
  return projects.slice(0, MAX_PROJECT_ROWS).map((p) => ({
    projectId: p.projectId,
    name: p.name,
    repo: p.repoUrl ? repoLabel(p.repoUrl) : null,
    imageUrl: p.repoUrl ? repoOgImage(p.repoUrl) : null,
    url: projectWebUrl(p.projectId),
    current: p.projectId === currentProjectId,
  }));
}
