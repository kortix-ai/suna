import type { AgentGrantSetV2 } from '@kortix/sdk';

/**
 * Keep `connectors_personal` a valid subset of the `connectors` grant.
 *
 * The manifest parser REJECTS an agent block whose personal set isn't a subset
 * of its grant, and a block that fails to parse breaks session-create for that
 * agent — so narrowing the grant must drop any personal entry that just lost it,
 * rather than saving a combination we know won't load. The server prunes the
 * same way; doing it in the editor keeps what the user sees equal to what gets
 * written.
 *
 * Returns `undefined` when nothing should be stored, matching the editor's
 * convention that an undefined draft key is omitted from the YAML entirely.
 */
export function prunePersonalConnectors(
  personal: string[] | undefined,
  grant: AgentGrantSetV2 | undefined,
): string[] | undefined {
  if (!personal?.length) return undefined;
  // 'all' grants every connector, so every personal entry stays valid.
  if (grant === 'all') return personal;
  // No grant at all (undefined or the 'none' sentinel) means nothing is granted,
  // so nothing can be personal.
  if (grant === undefined || grant === 'none') return undefined;
  const granted = new Set(grant);
  const kept = personal.filter((alias) => granted.has(alias));
  return kept.length ? kept : undefined;
}
