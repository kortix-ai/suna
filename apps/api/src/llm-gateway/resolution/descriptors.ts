import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { config } from '../../config';
import { OPENROUTER_APP_REFERER, OPENROUTER_APP_TITLE } from '../../openrouter-attribution';
import { getModelPricing } from '../../router/config/model-pricing';
import {
  CHATGPT_CODEX_BASE_URL,
  CODEX_USER_AGENT,
  type CodexCredential,
} from '../credentials/codex';
import type { ManagedModel } from '../models/managed-models';

export function bedrockBaseUrl(): string {
  return `https://bedrock-runtime.${config.AWS_BEDROCK_REGION || 'us-west-2'}.amazonaws.com`;
}

// Default region for a project's BYOK Bedrock connection when it hasn't set
// its own AWS_REGION secret. Deliberately separate from AWS_BEDROCK_REGION's
// 'us-west-2' default above — that constant belongs to the CLOUD-ONLY managed
// path (dosco's own AWS account/region choice); a BYOK project's default is
// its own, unrelated decision. us-east-1 is Bedrock's broadest-availability
// region (new models/cross-region inference profiles land there first).
const DEFAULT_BEDROCK_BYOK_REGION = 'us-east-1';

/**
 * Bedrock runtime endpoint for a project's OWN region (BYOK), as opposed to
 * `bedrockBaseUrl()` above which is the CLOUD-ONLY managed path's endpoint
 * (dosco's own AWS_BEDROCK_REGION config). Takes the region as a parameter —
 * never reads config — because the BYOK region is per-PROJECT (the project's
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
// geographies dosco has validated are mapped; an unrecognized region returns
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

function openRouterManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.OPENROUTER_API_KEY) return null;
  return {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: config.OPENROUTER_API_URL,
    apiKey: config.OPENROUTER_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    appName: OPENROUTER_APP_TITLE,
    appReferer: OPENROUTER_APP_REFERER,
    resolvedModel: managed.upstreamModelId,
    pricing: managedPricing(managed),
    ...(managed.openrouterProvider ? { bodyExtras: { provider: managed.openrouterProvider } } : {}),
  };
}

function asterManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.ASTER_API_KEY) return null;
  return {
    provider: 'aster',
    kind: 'openai-compat',
    baseUrl: config.ASTER_API_URL,
    apiKey: config.ASTER_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    resolvedModel: managed.upstreamModelId,
    pricing: managedPricing(managed),
  };
}

function bedrockManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.AWS_BEDROCK_API_KEY) return null;
  // NOTE — this is the MANAGED (dosco-credits) Bedrock path, reached only when
  // KORTIX_MANAGED_PROVIDER_ENABLED is on: it uses KORTIX'S OWN shared AWS
  // credentials and bills the user's dosco credits. It is NOT "how Bedrock
  // works." Bedrock is ALSO a standalone BYOK provider (like OpenRouter) — a
  // project connecting its OWN Bedrock API key gets a `kind:'bedrock'`
  // descriptor via the normal BYOK path (resolveCatalogUpstream('amazon-bedrock')
  // → resolveCandidates), fully independent of this managed flag. This managed
  // descriptor and the BYOK one share the same bedrock transport; they differ
  // only in whose credentials + billing they carry. See memory:
  // managed-provider-vs-standalone-byok.
  //
  // Managed Bedrock = Claude via the Anthropic InvokeModel/anthropic-payload transport.
  return {
    provider: 'bedrock',
    kind: 'bedrock',
    baseUrl: bedrockBaseUrl(),
    apiKey: config.AWS_BEDROCK_API_KEY,
    // Region for the AI-SDK engine's Bedrock provider (bearer-token auth still
    // comes from apiKey; region only picks the endpoint host). Ignored by the
    // native path, which bakes the region into baseUrl.
    region: config.AWS_BEDROCK_REGION || 'us-west-2',
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    resolvedModel: managed.upstreamModelId,
    pricing: managedPricing(managed),
  };
}

export function managedCandidates(managed: ManagedModel): UpstreamDescriptor[] {
  // CLOUD-ONLY gate, defense-in-depth: RUNTIME_MANAGED_MODELS is already empty
  // on a deployment with KORTIX_MANAGED_PROVIDER_ENABLED off (managed-models.ts),
  // so this only ever reaches a real ManagedModel when the flag is on — but
  // guard here too so no managed credential is read if some future caller
  // reaches this directly.
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED) return [];
  const d = {
    aster: asterManagedDescriptor,
    bedrock: bedrockManagedDescriptor,
    openrouter: openRouterManagedDescriptor,
  }[managed.transport](managed);
  return d ? [d] : [];
}

export function managedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  return managedCandidates(managed)[0] ?? null;
}

/**
 * Whether THIS deployment can actually reach `managed` — i.e. its transport's
 * credential is configured (ASTER_API_KEY / AWS_BEDROCK_API_KEY /
 * OPENROUTER_API_KEY) and the managed provider is on.
 *
 * The served catalog reads this so a model that would fail resolution is never
 * OFFERED. Without it, `/model-picker` advertised `glm-5.2` (the platform
 * default, transport `aster`) on a deployment with no ASTER_API_KEY, and every
 * attempt to select it came back `400 INVALID_SESSION_MODEL` — the picker and
 * request-time resolution disagreed because only resolution checked the
 * credential. Derived from `managedCandidates` rather than re-listing the env
 * vars, so the two can never drift.
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
