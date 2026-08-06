import type { ProjectConfigSummary } from '@kortix/sdk';

type Command = ProjectConfigSummary['commands'][number];

/**
 * Search-only filter for the Commands catalog. Unlike `filterSkills`, there
 * is no scope split here — commands have no `kortix-*` family, so this takes
 * just a query, not a `{ scope, query }` pair.
 */
export function filterCommands(
  commands: readonly Command[],
  opts: { query: string },
): Command[] {
  const q = opts.query.trim().toLowerCase();
  if (!q) return [...commands];
  return commands.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
  );
}
