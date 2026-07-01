import { Effect } from 'effect';
import { AppConfig, HttpClient } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const routerConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const KORTIX_MARKUP = 1.2;
export const PLATFORM_FEE_MARKUP = 0.1;

interface ToolPricing {
  baseCost: number;
  perResultCost: number;
  markupMultiplier: number;
}

const TOOL_PRICING: Record<string, ToolPricing> = {
  web_search_basic: { baseCost: 0.005, perResultCost: 0, markupMultiplier: 1.5 },
  web_search_advanced: { baseCost: 0.025, perResultCost: 0, markupMultiplier: 1.5 },
  image_search: { baseCost: 0.001, perResultCost: 0, markupMultiplier: 2.0 },
  proxy_tavily: { baseCost: 0.005, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_serper: { baseCost: 0.001, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_firecrawl: { baseCost: 0.01, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_replicate: { baseCost: 0.005, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_replicate_nano_banana: { baseCost: 0.01, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_replicate_gpt_image: { baseCost: 0.05, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_replicate_moondream: { baseCost: 0.002, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_replicate_poll: { baseCost: 0, perResultCost: 0, markupMultiplier: 1 },
  proxy_context7: { baseCost: 0.001, perResultCost: 0, markupMultiplier: 1.5 },
  proxy_freestyle_deploy: { baseCost: 0.01, perResultCost: 0, markupMultiplier: 1.5 },
};

export function getToolCost(toolName: string, resultCount: number = 0): number {
  const pricing = TOOL_PRICING[toolName];
  if (!pricing) return 0.01;
  return pricing.baseCost * pricing.markupMultiplier +
    pricing.perResultCost * pricing.markupMultiplier * resultCount;
}

export const routerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));

export const routerSleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));

export const runRouterInterval = (
  operation: () => void | Promise<void>,
  ms: number,
): void => {
  Effect.runFork(
    Effect.forever(
      Effect.zipRight(
        Effect.tryPromise(async () => operation()).pipe(Effect.catchAll(() => Effect.void)),
        Effect.sleep(`${ms} millis`),
      ),
    ),
  );
};
