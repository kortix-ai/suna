/**
 * `agents.<name>.connectors_required`: the connectors a session needs connected
 * before it starts. A connector is required only while the agent is granted it
 * by name (Specific): under All or None no single connector is picked. Pure,
 * so the agent page's rules are testable without a render.
 */

import type { AgentGrantSetV2 } from '@kortix/sdk';

/** `undefined` stands for an empty list: the key leaves kortix.yaml. */
type RequiredList = string[] | undefined;

/**
 * The required list after the grant changes to `next`. A connector dropped
 * from the pick list, or a switch to All or None, drops its Required flag.
 * Returns `required` itself when nothing changes, so the caller writes nothing.
 */
export function pruneRequiredConnectors(
  required: RequiredList,
  next: AgentGrantSetV2,
): RequiredList {
  const current = required ?? [];
  const picked = new Set(Array.isArray(next) ? next : []);
  const kept = current.filter((slug) => picked.has(slug));
  if (kept.length === current.length) return required;
  return kept.length ? kept : undefined;
}
