import type { AgentGrantSetV2 } from '@kortix/sdk';

/**
 * Keep `connectors_required` a valid subset of the `connectors` grant.
 *
 * The manifest parser rejects an agent block whose required set is not a subset
 * of its grant, and a block that fails to parse breaks session-create for that
 * agent. Narrowing the grant drops each required entry that lost its grant.
 * The server applies the same rule.
 *
 * Returns `undefined` when nothing should be stored, matching the editor's
 * convention that an undefined draft key is omitted from the YAML entirely.
 */
export function pruneRequiredConnectors(
  required: string[] | undefined,
  grant: AgentGrantSetV2 | undefined,
): string[] | undefined {
  if (!required?.length) return undefined;
  if (grant === 'all') return required;
  if (grant === undefined || grant === 'none') return undefined;
  const granted = new Set(grant);
  const kept = required.filter((slug) => granted.has(slug));
  return kept.length ? kept : undefined;
}
