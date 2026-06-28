import { isManagedModelId } from '@kortix/shared/llm-catalog';

/**
 * Pure resolution of the default model from configured preferences + a session's
 * project/agent context. Most-specific scope wins:
 *
 *   agent (DB override) > agent (kortix.toml [[agents]].model) > project (DB) >
 *   account (DB) > undefined (→ the gateway's platform `auto` target)
 *
 * Explicit picks and a trigger's own model are hard per-session overrides applied
 * upstream (the request never carries `auto`), so they sit above this chain.
 *
 * Returns undefined when nothing is configured, or when the candidate is a
 * managed model but the account is free-tier-only — the gateway then falls back
 * to the free platform target. Entitlement stays a gateway concern, never here.
 */
export function chooseDefaultModel(params: {
  accountDefault: string | null;
  projectDefaults: Record<string, string>;
  agentDefaults: Record<string, string>;
  agentManifestModel?: string | null;
  projectId?: string | null;
  agentName?: string | null;
  freeModelsOnly?: boolean;
}): string | undefined {
  const candidate =
    (params.agentName ? params.agentDefaults[params.agentName] : undefined) ??
    (params.agentManifestModel ?? undefined) ??
    (params.projectId ? params.projectDefaults[params.projectId] : undefined) ??
    (params.accountDefault ?? undefined);
  if (!candidate) return undefined;

  if (params.freeModelsOnly) {
    const bareId = candidate.startsWith('kortix/') ? candidate.slice('kortix/'.length) : candidate;
    if (isManagedModelId(bareId)) return undefined;
  }
  return candidate;
}
