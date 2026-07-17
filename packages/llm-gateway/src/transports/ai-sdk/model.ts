import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { UpstreamDescriptor } from '../../domain';

// Which AI SDK provider package a descriptor maps to. Prefer the models.dev
// `npm` field (verbatim from the live catalog, #4893); fall back to the transport
// `kind` so a descriptor that predates npm threading still resolves correctly.
export type AiSdkFamily = 'openai' | 'openai-compatible' | 'anthropic' | 'bedrock';

const OPENAI_NPM = '@ai-sdk/openai';
const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const BEDROCK_NPM = '@ai-sdk/amazon-bedrock';

export function aiSdkFamilyFor(descriptor: UpstreamDescriptor): AiSdkFamily {
  const npm = descriptor.npm;
  if (npm === OPENAI_NPM) return 'openai';
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === BEDROCK_NPM) return 'bedrock';
  // Fall back to the transport kind. `openai-compat`/`custom` → the generic
  // OpenAI-compatible provider (the safe default for any /v1/chat/completions
  // upstream, e.g. OpenRouter). anthropic/bedrock map to their native packages.
  switch (descriptor.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'bedrock':
      return 'bedrock';
    default:
      return 'openai-compatible';
  }
}

// AI-SDK-native model families the engine can serve. `openai-responses` (Codex)
// is intentionally excluded — it keeps the native transport regardless of engine.
export function isAiSdkServable(descriptor: UpstreamDescriptor): boolean {
  return descriptor.kind !== 'openai-responses';
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Anthropic's REST API rejects models.dev's dotted model-id convention
// outright: `{"type":"error","error":{"type":"not_found_error","message":
// "model: claude-haiku-4.5"}}` — confirmed live 2026-07-17 (dev
// req_mrp548h9o4t2bezg and 8 streaming-haiku siblings all 502 this exact way;
// candidates_tried: ["anthropic"], attempts: 0 — the direct-Anthropic
// candidate never even gets a real turn in). Anthropic only recognizes the
// dash form ("claude-haiku-4-5", which itself resolves server-side to the
// dated "claude-haiku-4-5-20251001") — verified live against both forms. The
// native anthropic transport already carries this exact translation
// (transports/anthropic/request.ts's `anthropicModelName`); mirrored here
// because the AI-SDK engine builds its own LanguageModel straight from the
// catalog's resolvedModel and never goes through that transport.
function anthropicModelName(model: string): string {
  return model.replace(/(\d)\.(\d)/g, '$1-$2');
}

// Amazon Nova's Bedrock Converse API hard-rejects (400) any call whose max
// output tokens exceeds the model's own ceiling instead of silently clamping
// it — confirmed live 2026-07-17 against Nova Micro: "The maximum tokens you
// requested exceeds the model limit of 10000. Try again with a maximum
// tokens value that is lower than 10000." A client/agent framework's generic
// default max_tokens (commonly tens of thousands, sized for Claude-class
// context) then 400s/502s EVERY call to a small Nova model, deterministically
// breaking a multi-turn tool loop before it can complete a single round trip
// (dev req_mrp4yx5cba2cvaa2 and 7 streaming siblings, all "amazon-bedrock/
// us.amazon.nova-micro-v1:0"). 10000 is Nova Micro's own live-confirmed
// ceiling, used as a conservative shared cap for the whole Nova family —
// Lite/Pro are documented to allow at least as much, never less — rather than
// a per-variant table that needs upkeep as AWS ships new Nova models. Only
// ever LOWERS an oversized request; a caller that already asked for less is
// untouched.
const NOVA_MAX_OUTPUT_TOKENS = 10_000;

function isNovaModel(resolvedModel: string | undefined): boolean {
  return /amazon\.nova-/i.test(resolvedModel ?? '');
}

export function clampMaxOutputTokensForBedrock(
  maxOutputTokens: number | undefined,
  family: AiSdkFamily,
  resolvedModel: string | undefined,
): number | undefined {
  if (family !== 'bedrock' || maxOutputTokens === undefined) return maxOutputTokens;
  if (!isNovaModel(resolvedModel)) return maxOutputTokens;
  return Math.min(maxOutputTokens, NOVA_MAX_OUTPUT_TOKENS);
}

// OpenRouter only returns the real, upstream-billed `usage.cost` figure when
// the request body carries `usage: {include: true}` — confirmed live
// 2026-07-17 (identical response otherwise, just missing the field), and not
// part of the vanilla OpenAI-compatible surface, so this stays scoped to
// OpenRouter rather than applied to every openai-compatible upstream (a
// stricter custom/self-hosted endpoint could reject an unrecognized top-level
// key the way Bedrock's Converse API does for Nova — see
// clampMaxOutputTokensForBedrock above). Threaded through as providerMetadata
// so sse.ts's mapUsage can fold it into the OpenAI-shaped `usage.cost` field
// the gateway's cost-hint extractor already reads (usage/extract.ts
// normalizeUsageChunk → pricing.ts's upstreamCostHint) — fixes a managed
// OpenRouter model with no models.dev catalog price booking $0 (defect 3).
export const OPENROUTER_COST_METADATA_KEY = 'openrouterCost';

function withOpenRouterUsageInclude(body: Record<string, unknown>): Record<string, unknown> {
  if (body.usage && typeof body.usage === 'object') return body;
  return { ...body, usage: { include: true } };
}

function costOfParsedBody(value: unknown): number | undefined {
  const usage = (value as { usage?: { cost?: unknown } } | null | undefined)?.usage;
  return typeof usage?.cost === 'number' ? usage.cost : undefined;
}

export function openRouterCostMetadataExtractor(): MetadataExtractor {
  return {
    extractMetadata: async ({ parsedBody }) => {
      const cost = costOfParsedBody(parsedBody);
      return cost === undefined ? undefined : { [OPENROUTER_COST_METADATA_KEY]: { cost } };
    },
    createStreamExtractor: () => {
      let cost: number | undefined;
      return {
        processChunk: (parsedChunk: unknown) => {
          const c = costOfParsedBody(parsedChunk);
          if (c !== undefined) cost = c;
        },
        buildMetadata: () =>
          cost === undefined ? undefined : { [OPENROUTER_COST_METADATA_KEY]: { cost } },
      };
    },
  };
}

// Build the AI SDK language model for this descriptor. The provider package owns
// every provider-specific wire quirk (endpoint shape, param names, tool schema
// translation, prompt caching, SSE decoding) — we only supply credentials, base
// URL, and the resolved model id.
export function resolveAiModel(descriptor: UpstreamDescriptor): LanguageModel {
  const modelId = descriptor.resolvedModel || '';
  const baseURL = descriptor.baseUrl ? trimTrailingSlash(descriptor.baseUrl) : undefined;
  const headers = descriptor.headers;
  const family = aiSdkFamilyFor(descriptor);

  switch (family) {
    case 'openai': {
      const provider = createOpenAI({ baseURL, apiKey: descriptor.apiKey, headers });
      // Use the Responses API, not chat.completions. OpenAI's reasoning models
      // (gpt-5.x, o-series) reject function tools alongside reasoning_effort on
      // /v1/chat/completions — the SDK injects reasoning_effort for them, so a
      // real gpt-5.6 tool-call turn 400s there. /v1/responses supports reasoning
      // + tools together, and the adapter output is identical either way.
      return provider.responses(modelId);
    }
    case 'anthropic': {
      const provider = createAnthropic({ baseURL, apiKey: descriptor.apiKey, headers });
      return provider(anthropicModelName(modelId));
    }
    case 'bedrock': {
      // Essentia + the enterprise appliance authenticate with a long-lived bearer
      // token (apiKey), not SigV4 — it takes precedence over AWS credentials in the
      // provider. Region is required by the SDK for the endpoint host.
      const provider = createAmazonBedrock({
        baseURL,
        apiKey: descriptor.apiKey,
        region: descriptor.region || process.env.AWS_REGION || 'us-east-1',
        headers,
      });
      return provider(modelId);
    }
    default: {
      const isOpenRouter = descriptor.provider === 'openrouter';
      const provider = createOpenAICompatible({
        name: descriptor.provider || 'openai-compatible',
        baseURL: baseURL || '',
        apiKey: descriptor.apiKey,
        headers,
        // Belt-and-suspenders (mirrors openai-compat/index.ts's
        // ensureStreamUsageForGenuineOpenAi): most modern openai-compatible
        // upstreams already send a usage-bearing trailing chunk without this,
        // but requesting it explicitly is the documented, correct way and
        // costs nothing when the upstream already does it by default.
        includeUsage: true,
        ...(isOpenRouter
          ? {
              transformRequestBody: withOpenRouterUsageInclude,
              metadataExtractor: openRouterCostMetadataExtractor(),
            }
          : {}),
      });
      return provider.chatModel(modelId);
    }
  }
}
