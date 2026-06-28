import { isManagedModelId } from '@kortix/shared/llm-catalog';

/**
 * Pure default-model decision used by the gateway's `auto` resolution:
 *   per-agent default → account default → undefined (→ platform default).
 *
 * Free tier cannot use managed Kortix models (managed resolution returns [] for
 * them by design), so a managed default is dropped for free-tier principals —
 * they fall back to the platform default, never to an unservable managed id. A
 * BYOK default (`provider/model`) is kept for free tier (resolved via their key).
 */
export function chooseDefaultModel(params: {
  accountDefault: string | null;
  agentDefaults: Record<string, string>;
  agentName?: string | null;
  freeModelsOnly?: boolean;
}): string | undefined {
  const candidate =
    (params.agentName ? params.agentDefaults[params.agentName] : undefined) ??
    params.accountDefault ??
    undefined;
  if (!candidate) return undefined;

  if (params.freeModelsOnly) {
    const bareId = candidate.startsWith('kortix/')
      ? candidate.slice('kortix/'.length)
      : candidate;
    if (isManagedModelId(bareId)) return undefined;
  }

  return candidate;
}
