import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── Default model preferences (account-scoped, gateway-resolved) ───────────
// The LLM gateway is the source of truth for concrete model defaults. These
// functions read and write account, workspace, and agent defaults. Stored values
// are gateway wire models (bare managed id, BYOK `provider/model`, or `codex/…`).

export type ModelDefaultScope = 'account' | 'agent' | 'workspace';
export type ModelDefaultSource = 'explicit' | 'agent' | 'workspace' | 'account' | 'platform';

export interface ModelDefaultsResponse {
  /** The platform-wide concrete fallback model. */
  platformDefault: string;
  /** Account-wide default wire model, or null when unset. */
  accountDefault: string | null;
  /** Per-agent default wire models, keyed by agent name. */
  agentDefaults: Record<string, string>;
  /** This workspace's default wire model, or null when unset. */
  workspaceDefault: string | null;
  /** Honest workspace-level resolution (workspace → account → platform) for display. */
  resolvedForCaller: string | null;
  /** Where `resolvedForCaller` came from — drives "· workspace default" labels. */
  resolvedSource?: ModelDefaultSource;
  /** True when the account can't use managed models (free tier). */
  freeTier: boolean;
}

export async function getModelDefaults(workspaceId: string) {
  return unwrap(
    await backendApi.get<ModelDefaultsResponse>(`/workspaces/${workspaceId}/model-defaults`),
  );
}

export async function setModelDefault(
  workspaceId: string,
  input: { scope: ModelDefaultScope; agentName?: string; model: string },
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; scope: string; agentName?: string; model: string }>(
      `/workspaces/${workspaceId}/model-defaults`,
      input,
    ),
  );
}

export async function clearModelDefault(
  workspaceId: string,
  params: { scope: ModelDefaultScope; agentName?: string },
) {
  const qs = new URLSearchParams({
    scope: params.scope,
    ...(params.agentName ? { agentName: params.agentName } : {}),
  }).toString();
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${workspaceId}/model-defaults?${qs}`,
    ),
  );
}
