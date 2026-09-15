import type { Config } from '@opencode-ai/sdk/v2/client';
import type { ModelKey } from './use-model-store';
import { resolveSessionDisplayModel } from './session-display-model';

export function sessionReasoningVariants(
  runtime: 'pi-worker' | 'opencode' | undefined,
  config: Config | undefined,
  catalogVariants: Record<string, unknown> | undefined,
): string[] {
  if (runtime !== 'pi-worker') return Object.keys(catalogVariants ?? {});
  const model = resolveSessionDisplayModel(runtime, config?.model, undefined);
  if (!model) return [];
  const variants = config?.provider?.[model.providerID]?.models?.[model.modelID]?.variants;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return [];
  return Object.entries(variants)
    .filter(([, value]) => value && typeof value === 'object' && value.disabled !== true)
    .map(([level]) => level);
}

export function sessionReasoningStorageKey(
  runtime: 'pi-worker' | 'opencode' | undefined,
  sessionId: string | undefined,
  model: ModelKey | undefined,
): ModelKey | undefined {
  if (runtime !== 'pi-worker') return model;
  if (!sessionId || !model) return undefined;
  return {
    providerID: 'kortix:session-reasoning',
    modelID: JSON.stringify([sessionId, model.providerID, model.modelID]),
  };
}
