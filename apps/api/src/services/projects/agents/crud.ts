import { createHash } from 'node:crypto';
import { type AgentSpec, type GrantSet, MANIFEST_FILENAME } from './types';

/**
 * Convert an AgentSpec back to the raw manifest-entry object for the CRUD
 * round-trip (serialized as YAML for `kortix.yaml`, or TOML for a legacy v1
 * `kortix.toml`). Inverse of `parseAgentEntry`. Omits empty/default fields so
 * the emitted entry stays minimal.
 */
export function agentSpecToTomlEntry(spec: AgentSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: spec.name };
  if (!spec.enabled) entry.enabled = false;
  if (spec.file) entry.file = spec.file;
  if (spec.model) entry.model = spec.model;
  if (spec.connectors === 'all') entry.connectors = 'all';
  else if (spec.connectors.length > 0) entry.connectors = spec.connectors;
  if (spec.permissions === 'all') entry.kortix_permissions = 'all';
  else if (spec.permissions.length > 0) entry.kortix_permissions = spec.permissions;
  // 'all' is the env default, so only emit when narrowed (a list or explicit none).
  if (spec.env !== 'all') entry.env = spec.env;
  // none is the default → omit; 'all'/a list is explicit.
  if (spec.apps === 'all') entry.apps = 'all';
  else if (spec.apps && spec.apps.length > 0) entry.apps = spec.apps;
  return entry;
}

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

/**
 * Stable hash over what should trigger a re-reconcile of the agent's grant.
 * `name` is excluded — renaming is handled by the name being the key.
 */
export function manifestHashForAgent(spec: AgentSpec): string {
  const canonical = JSON.stringify({
    enabled: spec.enabled,
    connectors: spec.connectors,
    connectorsRequired: spec.connectorsRequired,
    permissions: spec.permissions,
    env: spec.env,
    // Only when declared, so the hash of every agent that never mentions Apps
    // is unchanged by this field's introduction.
    ...(spec.apps && (spec.apps === 'all' || spec.apps.length > 0) ? { apps: spec.apps } : {}),
    file: spec.file,
    repositoryAccess: spec.repositoryAccess,
    legacyReadWorkspace: spec.legacyReadWorkspace,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
