import { MANAGED_MODELS } from '@kortix/llm-catalog';

export interface ManagedPriceRoute {
  route: string;
  role: 'preferred' | 'eligible';
  /** Customer USD per million tokens, including the configured markup. */
  input: number;
  cacheRead: number;
  output: number;
}

function billed(value: number, markup: number): number {
  return Math.round(value * markup * 1_000_000) / 1_000_000;
}

/** Rates for routes the gateway may select, ordered by request priority. */
export function managedPricingRoutes(
  morphModelIds: readonly string[],
  markup: number,
  morphAvailable: boolean,
): Record<string, ManagedPriceRoute[]> {
  const selected = new Set(morphModelIds);
  const result: Record<string, ManagedPriceRoute[]> = {};
  for (const model of MANAGED_MODELS) {
    const routes: ManagedPriceRoute[] = [];
    if (morphAvailable && selected.has(model.id) && model.morphModelId && model.morphPricing) {
      routes.push({
        route: 'morph', role: 'preferred',
        input: billed(model.morphPricing.inputPerMillion, markup),
        cacheRead: billed(model.morphPricing.cachedInputPerMillion ?? model.morphPricing.inputPerMillion, markup),
        output: billed(model.morphPricing.outputPerMillion, markup),
      });
    }
    const allowed = (model.openrouterProvider as { only?: string[] } | undefined)?.only ?? [];
    for (const tag of allowed) {
      const price = model.openrouterEndpointPricing?.[tag];
      if (!price) continue;
      routes.push({
        route: tag, role: 'eligible',
        input: billed(price.inputPerMillion, markup),
        cacheRead: billed(price.cachedInputPerMillion, markup),
        output: billed(price.outputPerMillion, markup),
      });
    }
    if (routes.length) result[model.id] = routes;
  }
  return result;
}
