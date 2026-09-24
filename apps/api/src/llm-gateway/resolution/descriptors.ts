import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { config } from '../../config';
import { getModelPricing } from '../../router/config/model-pricing';
import {
  CHATGPT_CODEX_BASE_URL,
  CODEX_USER_AGENT,
  type CodexCredential,
} from '../credentials/codex';
import type { ManagedModel } from '../models/managed-models';

// Default region for a project's BYOK Bedrock connection when it hasn't set
// its own AWS_REGION secret. us-east-1 is Bedrock's broadest-availability
// region (new models/cross-region inference profiles land there first).
const DEFAULT_BEDROCK_BYOK_REGION = 'us-east-1';

/**
 * Bedrock runtime endpoint for a project's own region (BYOK).
 * Takes the region as a parameter and never reads config. The BYOK region is the project's
 * own AWS_REGION secret, resolved by resolve-candidates.ts, which has the
 * project context this module doesn't), not a deployment-wide setting.
 */
export function bedrockByokBaseUrl(region: string | null | undefined): string {
  const trimmed = region?.trim();
  return `https://bedrock-runtime.${trimmed || DEFAULT_BEDROCK_BYOK_REGION}.amazonaws.com`;
}

// Bedrock cross-region ("global") inference profiles prepend a geography code
// to the base model id so a single logical model can route across multiple
// AWS regions — e.g. `us.anthropic.claude-sonnet-4-20250514-v1:0` instead of
// the base `anthropic.claude-sonnet-4-20250514-v1:0` (see AWS's "cross-region
// inference" docs; the same base model can also appear as `eu.` or `apac.`).
// The models.dev catalog only ever carries the base (unprefixed) id, so a
// pricing lookup keyed by the prefixed id silently misses and produces a $0
// upstream-cost hint. This list is intentionally exhaustive over AWS's
// published prefixes, not just the first path segment before a dot, so it
// never mis-strips a legitimate base id that happens to start with one of
// these codes (there is no `us.*` or `eu.*` Bedrock model family today, but
// checking the known set instead of "any leading `xx.`" keeps that true).
const BEDROCK_INFERENCE_PROFILE_PREFIXES = ['us-gov', 'us', 'eu', 'apac'] as const;

/**
 * Strip a Bedrock cross-region inference-profile prefix (`us.`, `eu.`,
 * `apac.`, `us-gov.`) from a model id, for PRICING lookups only — never for
 * the id actually sent to the Bedrock InvokeModel API, which still needs the
 * full profile id to route correctly. Bedrock-scoped: only ever call this for
 * `kind === 'bedrock'` descriptors; other providers' ids never carry these
 * prefixes and shouldn't be run through this heuristic.
 */
export function stripBedrockInferenceProfilePrefix(modelId: string): string {
  for (const prefix of BEDROCK_INFERENCE_PROFILE_PREFIXES) {
    const withDot = `${prefix}.`;
    if (modelId.startsWith(withDot) && modelId.length > withDot.length) {
      return modelId.slice(withDot.length);
    }
  }
  return modelId;
}

// The geography prefixes a CONFIGURED Anthropic-on-Bedrock model id might
// already carry. Broader than the pricing-strip list above: it also includes
// the region-specific `jp` (Tokyo) and `au` (Sydney) profiles, which are
// exactly the ones that end up mismatched against a us-/eu- endpoint.
const BEDROCK_ANTHROPIC_GEO_PREFIXES = ['us-gov', 'us', 'eu', 'apac', 'jp', 'au'] as const;

// AWS region → the Bedrock cross-region inference-profile geography prefix its
// endpoint accepts. A profile's geography MUST match the endpoint region's
// geography — invoking `jp.anthropic.*` against a us-east-1 endpoint 400s "The
// provided model identifier is invalid." (verified against real Bedrock). Only
// geographies Kortix has validated are mapped; an unrecognized region returns
// undefined so normalization is skipped — never rewrite toward a prefix we
// can't vouch for.
function regionInferenceGeoPrefix(region: string): string | undefined {
  const r = region.trim().toLowerCase();
  if (r.startsWith('us-gov-')) return 'us-gov';
  if (r.startsWith('us-')) return 'us';
  if (r.startsWith('eu-')) return 'eu';
  if (r.startsWith('ap-')) return 'apac';
  return undefined;
}

/**
 * Normalize an Anthropic-on-Bedrock model id's cross-region inference-profile
 * geography prefix to match the endpoint `region`. A configured id can arrive
 * with a stale/wrong geography — a picked catalog variant, an old account
 * default, a session pin (e.g. `jp.anthropic.claude-opus-5` on a us-east-1
 * box) — which Bedrock rejects with an opaque `400 The provided model
 * identifier is invalid.` before the turn even starts. Rewriting the prefix to
 * the endpoint's geography makes a region-mismatched pick self-heal.
 *
 * Safe by construction: only rewrites a KNOWN geography prefix to a KNOWN
 * target geography, and only for `*.anthropic.*` ids. Leaves bare ids,
 * `global.` profiles, non-Anthropic families, and ids under an unrecognized
 * region untouched — so it can only ever turn an id that WOULD 400 on this
 * endpoint into the one that works, never break an already-valid id.
 * Bedrock-scoped: call only for `kind === 'bedrock'`.
 */
export function normalizeBedrockInferenceProfileRegion(
  modelId: string,
  region: string | null | undefined,
): string {
  const target = regionInferenceGeoPrefix(region?.trim() || DEFAULT_BEDROCK_BYOK_REGION);
  if (!target) return modelId;
  for (const prefix of BEDROCK_ANTHROPIC_GEO_PREFIXES) {
    const withDot = `${prefix}.anthropic.`;
    if (modelId.startsWith(withDot)) {
      return prefix === target ? modelId : `${target}.anthropic.${modelId.slice(withDot.length)}`;
    }
  }
  return modelId;
}

export function livePricing(
  providerId: string,
  modelId: string,
): UpstreamDescriptor['pricing'] | undefined {
  const p = getModelPricing(providerId, modelId);
  if (!p) return undefined;
  return {
    inputPerMillion: p.inputPer1M,
    outputPerMillion: p.outputPer1M,
    cachedInputPerMillion: p.cacheReadPer1M,
    cacheWritePerMillion: p.cacheWritePer1M,
    tiers: p.tiers?.map((tier) => ({
      inputPerMillion: tier.inputPer1M,
      outputPerMillion: tier.outputPer1M,
      cachedInputPerMillion: tier.cacheReadPer1M,
      cacheWritePerMillion: tier.cacheWritePer1M,
      contextThreshold: tier.contextThreshold,
    })),
    contextOver200k: p.contextOver200k
      ? {
          inputPerMillion: p.contextOver200k.inputPer1M,
          outputPerMillion: p.contextOver200k.outputPer1M,
          cachedInputPerMillion: p.contextOver200k.cacheReadPer1M,
          cacheWritePerMillion: p.contextOver200k.cacheWritePer1M,
          contextThreshold: p.contextOver200k.contextThreshold,
        }
      : undefined,
  };
}

function managedPricing(managed: ManagedModel): UpstreamDescriptor['pricing'] | undefined {
  if (managed.pricing) return managed.pricing;
  const slash = managed.pricingRef.indexOf('/');
  if (slash <= 0) return undefined;
  return livePricing(managed.pricingRef.slice(0, slash), managed.pricingRef.slice(slash + 1));
}

function morphManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!managed.morphModelId || !config.MORPH_API_KEY) return null;
  return {
    provider: 'morph',
    kind: 'openai-compat',
    baseUrl: config.MORPH_API_URL,
    apiKey: config.MORPH_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    resolvedModel: managed.morphModelId,
    // Morph reports no per-request cost, so its list prices bill the request.
    pricing: managedPricing(managed),
    failover: true,
    publicProvider: 'kortix',
  };
}

function openRouterManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.OPENROUTER_API_KEY) return null;
  return {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: config.OPENROUTER_API_URL,
    apiKey: config.OPENROUTER_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    resolvedModel: managed.upstreamModelId,
    // OpenRouter reports `usage.cost` for the endpoint that served the request;
    // the gateway bills that. This table applies only when the cost is absent.
    pricing: managedPricing(managed),
    bodyExtras: {
      provider: {
        allow_fallbacks: false,
        ...managed.openrouterProvider,
        zdr: true,
        data_collection: 'deny',
      },
    },
    failover: true,
    publicProvider: 'kortix',
  };
}

/**
 * Upstreams for a managed model, in dispatch order: Morph direct first, then
 * the OpenRouter endpoint pool. Every candidate sets `failover`, so the gateway
 * sends a request that fails on Morph (HTTP error or network error before any
 * output) to OpenRouter. Users see only the Kortix model either way.
 */
export function managedCandidates(managed: ManagedModel): UpstreamDescriptor[] {
  // CLOUD-ONLY gate, defense-in-depth: RUNTIME_MANAGED_MODELS is already empty
  // on a deployment with KORTIX_MANAGED_PROVIDER_ENABLED off (managed-models.ts),
  // so this only ever reaches a real ManagedModel when the flag is on — but
  // guard here too so no managed credential is read if some future caller
  // reaches this directly.
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED) return [];
  return [morphManagedDescriptor(managed), openRouterManagedDescriptor(managed)].filter(
    (descriptor): descriptor is UpstreamDescriptor => descriptor !== null,
  );
}

export function managedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  return managedCandidates(managed)[0] ?? null;
}

/**
 * Whether THIS deployment can actually reach `managed` — i.e. its transport's
 * credential is configured (MORPH_API_KEY or OPENROUTER_API_KEY) and the
 * managed provider is on.
 *
 * The served catalog reads this so a model that would fail resolution is never
 * OFFERED. Derived from `managedCandidates` rather than re-listing the env
 * vars, so the catalog and request-time resolution cannot drift.
 */
export function managedTransportAvailable(managed: ManagedModel): boolean {
  return managedCandidates(managed).length > 0;
}

export function codexDescriptor(credential: CodexCredential, model: string): UpstreamDescriptor {
  const headers: Record<string, string> = {
    originator: 'codex_cli_rs',
    'User-Agent': CODEX_USER_AGENT,
    'OpenAI-Beta': 'responses=experimental',
  };
  if (credential.accountId) headers['ChatGPT-Account-ID'] = credential.accountId;

  return {
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: CHATGPT_CODEX_BASE_URL,
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: model.replace(/^codex\//, ''),
    headers,
  };
}
