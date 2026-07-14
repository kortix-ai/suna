import {
  MANAGED_MODELS as BUNDLED_MANAGED_MODELS,
  type ManagedModel,
} from '@kortix/llm-catalog';
import { z } from 'zod';
import { config } from '../../config';

const managedModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  upstreamModelId: z.string().min(1),
  transport: z.enum(['bedrock', 'openrouter']),
  pricingRef: z.string().min(1),
  tier: z.enum(['flagship', 'balanced', 'fast']),
  vision: z.boolean(),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }),
  openrouterProvider: z.record(z.unknown()).optional(),
});

export function parseManagedModels(
  raw: string | undefined,
  fallback: readonly ManagedModel[] = BUNDLED_MANAGED_MODELS,
): ManagedModel[] {
  if (!raw) return [...fallback];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `LLM_GATEWAY_MANAGED_MODELS must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const models = z.array(managedModelSchema).parse(parsed) as ManagedModel[];
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`LLM_GATEWAY_MANAGED_MODELS contains duplicate model id "${model.id}"`);
    }
    ids.add(model.id);
  }
  return models;
}

/** API/control-plane managed model overlay used by runtime routing and catalog responses. */
export const RUNTIME_MANAGED_MODELS: readonly ManagedModel[] = parseManagedModels(
  config.LLM_GATEWAY_MANAGED_MODELS,
);

const MANAGED_BY_ID = new Map(RUNTIME_MANAGED_MODELS.map((model) => [model.id, model] as const));

export function getRuntimeManagedModel(id: string): ManagedModel | undefined {
  return MANAGED_BY_ID.get(id);
}

export function isRuntimeManagedModelId(id: string): boolean {
  return MANAGED_BY_ID.has(id);
}

export type { ManagedModel };
