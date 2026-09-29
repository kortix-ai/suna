import type { ProjectSession } from '@kortix/sdk';

export function matchesLabelFilters(session: ProjectSession, labels: readonly string[]): boolean {
  return labels.length === 0 || labels.some((label) => session.labels?.includes(label));
}
