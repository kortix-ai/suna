import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import type { ManagedModel } from '@kortix/shared/llm-catalog';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { config } from '../../config';
import { getModelPricing } from '../../router/config/model-pricing';
import {
  CHATGPT_CODEX_BASE_URL,
  CODEX_USER_AGENT,
  type CodexCredential,
} from '../credentials/codex';

export function bedrockBaseUrl(): string {
  return `https://bedrock-runtime.${config.AWS_BEDROCK_REGION || 'us-west-2'}.amazonaws.com`;
}

export function livePricing(modelId: string): UpstreamDescriptor['pricing'] | undefined {
  const p = getModelPricing(modelId);
  if (!p) return undefined;
  return {
    inputPerMillion: p.inputPer1M,
    outputPerMillion: p.outputPer1M,
    cachedInputPerMillion: p.cacheReadPer1M,
  };
}

function bedrockManagedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  if (!config.AWS_BEDROCK_API_KEY) return null;
  return {
    provider: 'bedrock',
    kind: 'bedrock',
    baseUrl: bedrockBaseUrl(),
    apiKey: config.AWS_BEDROCK_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    resolvedModel: managed.bedrockModelId,
    pricing: livePricing(managed.bedrockModelId),
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
    appName: 'Kortix',
    appReferer: config.KORTIX_URL,
    resolvedModel: managed.openRouterModelId,
    pricing: livePricing(managed.openRouterModelId),
  };
}

export function managedCandidates(managed: ManagedModel): UpstreamDescriptor[] {
  return [bedrockManagedDescriptor(managed), openRouterManagedDescriptor(managed)].filter(
    (d): d is UpstreamDescriptor => d !== null,
  );
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
