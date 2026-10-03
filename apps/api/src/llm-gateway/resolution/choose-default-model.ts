import { chooseEffectiveModel } from './effective';

/**
 * Pure default-model decision used by the gateway:
 *   per-agent default → project default → account default → undefined (→ platform).
 *
 * Thin adapter over `chooseEffectiveModel` (the single precedence definition) that
 * returns the gateway's `string | undefined` shape. Free tier cannot use a managed
 * Kortix model except the platform default (the one managed model it may run,
 * KRTX-1067), so another managed chosen default is dropped to the platform
 * default — never silently downgraded to a broader layer. A BYOK
 * default (`provider/model`) is kept for free tier (resolved via their key).
 */
export function chooseDefaultModel(params: {
  accountDefault: string | null;
  agentDefaults: Record<string, string>;
  agentName?: string | null;
  projectDefault?: string | null;
  freeModelsOnly?: boolean;
  /** The deployment's served platform default — see `chooseEffectiveModel`. */
  platformDefault?: string | null;
}): string | undefined {
  const { model } = chooseEffectiveModel({
    agentDefault: params.agentName ? params.agentDefaults[params.agentName] : null,
    projectDefault: params.projectDefault ?? null,
    accountDefault: params.accountDefault,
    freeModelsOnly: params.freeModelsOnly,
    platformDefault: params.platformDefault,
  });
  return model ?? undefined;
}
