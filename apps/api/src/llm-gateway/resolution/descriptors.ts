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
// path (Kortix's own AWS account/region choice); a BYOK project's default is
// its own, unrelated decision. us-east-1 is Bedrock's broadest-availability
// region (new models/cross-region inference profiles land there first).
const DEFAULT_BEDROCK_BYOK_REGION = 'us-east-1';

/**
 * Bedrock runtime endpoint for a project's OWN region (BYOK), as opposed to
 * `bedrockBaseUrl()` above which is the CLOUD-ONLY managed path's endpoint
 * (Kortix's own AWS_BEDROCK_REGION config). Takes the region as a parameter —
 * never reads config — because the BYOK region is per-PROJECT (the project's
 * own AWS_REGION secret, resolved by resolve-candidates.ts, which has the
 * project context this module doesn't), not a deployment-wide setting.
 */
export function bedrockByokBaseUrl(region: string | null | undefined): string {
  const trimmed = region?.trim();
  return `https://bedrock-runtime.${trimmed || DEFAULT_BEDROCK_BYOK_REGION}.amazonaws.com`;
}

export function livePricing(modelId: string): UpstreamDescriptor['pricing'] | undefined {
  const p = getModelPricing(modelId);
  if (!p) return undefined;
  return {
    inputPerMillion: p.inputPer1M,
    outputPerMillion: p.outputPer1M,
    cachedInputPerMillion: p.cacheReadPer1M,
    cacheWritePerMillion: p.cacheWritePer1M,
  };
}

function managedPricing(managed: ManagedModel): UpstreamDescriptor['pricing'] | undefined {
  return livePricing(managed.pricingRef);
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

function bedrockManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.AWS_BEDROCK_API_KEY) return null;
  // NOTE — this is the MANAGED (Kortix-credits) Bedrock path, reached only when
  // KORTIX_MANAGED_PROVIDER_ENABLED is on: it uses KORTIX'S OWN shared AWS
  // credentials and bills the user's Kortix credits. It is NOT "how Bedrock
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
  // guard here too so neither AWS_BEDROCK_API_KEY nor OPENROUTER_API_KEY is
  // ever read for managed routing if some future caller reaches this directly.
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED) return [];
  const d =
    managed.transport === 'openrouter'
      ? openRouterManagedDescriptor(managed)
      : bedrockManagedDescriptor(managed);
  return d ? [d] : [];
}

export function managedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  return managedCandidates(managed)[0] ?? null;
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
