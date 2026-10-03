import { chooseEffectiveModel } from './effective';

/**
 * Pure default-model decision used by the gateway:
 *   per-agent default → project default → undefined (→ platform).
 *
 * Thin adapter over `chooseEffectiveModel` (the single precedence definition) that
 * returns the gateway's `string | undefined` shape. Free tier cannot use managed
 * Kortix models, so a managed chosen default is dropped to the platform default —
 * never silently downgraded to a broader layer. A BYOK default (`provider/model`)
 * is kept for free tier (resolved via their key).
 */
export function chooseDefaultModel(params: {
  agentDefaults: Record<string, string>;
  agentName?: string | null;
  projectDefault?: string | null;
  freeModelsOnly?: boolean;
}): string | undefined {
  const { model } = chooseEffectiveModel({
    agentDefault: params.agentName ? params.agentDefaults[params.agentName] : null,
    projectDefault: params.projectDefault ?? null,
    freeModelsOnly: params.freeModelsOnly,
  });
  return model ?? undefined;
}
