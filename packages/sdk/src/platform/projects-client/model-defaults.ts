// ── Default model preferences (account-scoped, gateway-resolved) ───────────
// The LLM gateway is the source of truth for the default model: a request for
// the synthetic `auto` resolves server-side to the per-agent default → account
// default → platform default. These read/write the account+agent defaults
// (operating on the project's owner account). Stored values are gateway wire
// models (bare managed id, BYOK `provider/model`, or `codex/…`).

import { backendApi } from '../api-client';
import { unwrap } from './shared';

export interface ModelDefaultsResponse {
  /** The platform-wide fallback model (what `auto` resolves to with no override). */
  platformDefault: string;
  /** Account-wide default wire model, or null when unset. */
  accountDefault: string | null;
  /** Per-agent default wire models, keyed by agent name. */
  agentDefaults: Record<string, string>;
  /** Account-level resolution for picker display (agent/vision-agnostic). */
  resolvedForCaller: string | null;
  /** True when the account can't use managed models (free tier). */
  freeTier: boolean;
}

export async function getModelDefaults(projectId: string) {
  return unwrap(
    await backendApi.get<ModelDefaultsResponse>(`/projects/${projectId}/model-defaults`),
  );
}

export async function setModelDefault(
  projectId: string,
  input: { scope: 'account' | 'agent'; agentName?: string; model: string },
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; scope: string; agentName?: string; model: string }>(
      `/projects/${projectId}/model-defaults`,
      input,
    ),
  );
}

export async function clearModelDefault(
  projectId: string,
  params: { scope: 'account' | 'agent'; agentName?: string },
) {
  const qs = new URLSearchParams({
    scope: params.scope,
    ...(params.agentName ? { agentName: params.agentName } : {}),
  }).toString();
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/model-defaults?${qs}`),
  );
}
