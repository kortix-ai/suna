/**
 * Whether the agent picker should group rows under harness headings.
 * Grouping only earns its place once agents actually span more than one
 * harness — a single-harness project (the common case) gets a flat list
 * instead of a pointless one-group heading (2026-07-14 agent selector UX
 * pass). `null` entries (agents with no resolvable harness) count as their
 * own "other" bucket like the picker itself does.
 */
export function shouldGroupAgentsByHarness(harnesses: Array<string | null>): boolean {
  const distinct = new Set(harnesses.map((harness) => harness ?? 'other'));
  return distinct.size > 1;
}
