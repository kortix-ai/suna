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
  openrouterAvailable = true,
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
    const allowed = openrouterAvailable
      ? (model.openrouterProvider as { only?: string[] } | undefined)?.only ?? []
      : [];
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

type PricingFetch = typeof fetch;

interface PricingFeedOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: PricingFetch;
}

function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

/** Read only the endpoints the gateway allows; keep public table rates on feed failure. */
export async function refreshManagedPricingRoutes(
  morphModelIds: readonly string[],
  markup: number,
  morphAvailable: boolean,
  options: PricingFeedOptions,
): Promise<Record<string, ManagedPriceRoute[]>> {
  const quoted = managedPricingRoutes(morphModelIds, markup, morphAvailable, Boolean(options.apiKey));
  if (!options.apiKey) return quoted;
  const fetchImpl = options.fetchImpl ?? fetch;
  await Promise.all(MANAGED_MODELS.map(async (model) => {
    const allowed = new Set((model.openrouterProvider as { only?: string[] } | undefined)?.only ?? []);
    if (!allowed.size) return;
    try {
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, '')}/models/${model.upstreamModelId}/endpoints`,
        { headers: { Authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(2500) },
      );
      if (!response.ok) return;
      const payload = await response.json() as { data?: { endpoints?: Array<{
        tag?: string;
        pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
      }> } };
      for (const endpoint of payload.data?.endpoints ?? []) {
        if (!endpoint.tag || !allowed.has(endpoint.tag)) continue;
        const input = perMillion(endpoint.pricing?.prompt);
        const output = perMillion(endpoint.pricing?.completion);
        const cacheRead = perMillion(endpoint.pricing?.input_cache_read);
        if (input === null || output === null || cacheRead === null) continue;
        const max = (model.openrouterProvider as { max_price?: { prompt: number; completion: number } } | undefined)?.max_price;
        if (max && (input > max.prompt || output > max.completion)) {
          quoted[model.id] = quoted[model.id]?.filter((route) => route.route !== endpoint.tag) ?? [];
          continue;
        }
        const route = quoted[model.id]?.find((entry) => entry.route === endpoint.tag);
        if (!route) continue;
        route.input = billed(input, markup);
        route.cacheRead = billed(cacheRead, markup);
        route.output = billed(output, markup);
      }
    } catch {
      // The verified public rate table remains the estimate while the feed is down.
    }
  }));
  return quoted;
}

let cachedQuote: { key: string; expiresAt: number; value: Promise<Record<string, ManagedPriceRoute[]>> } | undefined;

/** Reuse one bounded provider-price fetch across model-picker requests for five minutes. */
export function cachedManagedPricingRoutes(
  morphModelIds: readonly string[],
  markup: number,
  morphAvailable: boolean,
  options: PricingFeedOptions,
): Promise<Record<string, ManagedPriceRoute[]>> {
  const key = JSON.stringify([morphModelIds, markup, morphAvailable, options.baseUrl]);
  const now = Date.now();
  if (cachedQuote?.key === key && cachedQuote.expiresAt > now) return cachedQuote.value;
  const value = refreshManagedPricingRoutes(morphModelIds, markup, morphAvailable, options);
  cachedQuote = { key, expiresAt: now + 300_000, value };
  return value;
}
