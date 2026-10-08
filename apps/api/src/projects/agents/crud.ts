import { type GrantSet, MANIFEST_FILENAME } from './types';

/**
 * Apply a secrets/connectors scope edit to the RAW `agents` array (v1's
 * `[[agents]]` array-of-tables shape; the dashboard "Access scope" editor's
 * write step), returning a new array. Pure — the route wraps it with
 * load/commit. Preserves every other field on the entry (name, model, file,
 * kortix_permissions, enabled) and omits a key when it equals the parser default so
 * the emitted manifest matches hand-authored files:
 *   - env:        'all' is the default → omit; a list/`[]` narrows it.
 *   - connectors: none is the default → omit `[]`; 'all'/a list is explicit.
 * Returns an error (not a throw) when the agent isn't declared.
 */
export function applyAgentScope(
  agents: Record<string, unknown>[],
  agentName: string,
  scope: { env?: GrantSet; connectors?: GrantSet },
  filename: string = MANIFEST_FILENAME,
): { ok: true; agents: Record<string, unknown>[] } | { ok: false; error: string } {
  const idx = agents.findIndex((a) => a && (a as { name?: unknown }).name === agentName);
  if (idx < 0) return { ok: false, error: `No agent "${agentName}" declared in ${filename}` };
  const entry = { ...agents[idx] };
  if (scope.env !== undefined) {
    if (scope.env === 'all') delete entry.env;
    else entry.env = scope.env;
  }
  if (scope.connectors !== undefined) {
    if (scope.connectors === 'all') entry.connectors = 'all';
    else if (scope.connectors.length === 0) delete entry.connectors;
    else entry.connectors = scope.connectors;
  }
  const next = [...agents];
  next[idx] = entry;
  return { ok: true, agents: next };
}
