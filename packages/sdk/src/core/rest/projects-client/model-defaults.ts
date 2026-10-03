import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── Default model preferences (gateway-resolved) ───────────────────────────
// The LLM gateway is the source of truth for concrete model defaults. These
// functions read and write project and agent defaults. Stored values are
// gateway wire models (bare managed id, BYOK `provider/model`, or `codex/…`).

export type ModelDefaultScope = 'agent' | 'project';
export type ModelDefaultSource = 'explicit' | 'agent' | 'project' | 'platform';

export interface ModelDefaultsResponse {
  /** The platform-wide concrete fallback model. */
  platformDefault: string;
  /** Per-agent default wire models, keyed by agent name. */
  agentDefaults: Record<string, string>;
  /** This project's default wire model, or null when unset. */
  projectDefault: string | null;
  /** Honest project-level resolution (project → account → platform) for display. */
  resolvedForCaller: string | null;
  /** Where `resolvedForCaller` came from — drives "· project default" labels. */
  resolvedSource?: ModelDefaultSource;
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
  input: { scope: ModelDefaultScope; agentName?: string; model: string },
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
  params: { scope: ModelDefaultScope; agentName?: string },
) {
  const qs = new URLSearchParams({
    scope: params.scope,
    ...(params.agentName ? { agentName: params.agentName } : {}),
  }).toString();
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/model-defaults?${qs}`,
    ),
  );
}
