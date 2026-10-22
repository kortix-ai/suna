import type { ProjectSession } from '@kortix/sdk';

/**
 * The Labels facet's options: every label on the loaded sessions with its
 * count, plus each selected label (count 0 when no loaded session carries it,
 * so it can still be unchecked). Most-used first, then by name.
 *
 * ponytail: options come from the loaded pages only; a label that lives only on
 * an older, unloaded session is not offered. Add a project label index if that
 * starts to matter.
 */
export function resolveLabelFacetOptions(
  sessions: readonly Pick<ProjectSession, 'labels'>[],
  selected: readonly string[],
): { value: string; count: number }[] {
  const counts = new Map<string, number>(selected.map((label) => [label, 0]));
  for (const session of sessions) {
    for (const label of session.labels ?? []) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
