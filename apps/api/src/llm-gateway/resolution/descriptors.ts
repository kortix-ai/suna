import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import type { ManagedModel } from '@kortix/shared/llm-catalog';
import { config } from '../../config';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { CHATGPT_CODEX_BASE_URL, CODEX_USER_AGENT, type CodexCredential } from '../credentials/codex';

export function bedrockBaseUrl(): string {
  return `https://bedrock-runtime.${config.AWS_BEDROCK_REGION || 'us-west-2'}.amazonaws.com`;
}

export function managedDescriptor(managed: ManagedModel): UpstreamDescriptor | null {
  const pricing = {
    inputPerMillion: managed.inputPerMillion,
    outputPerMillion: managed.outputPerMillion,
    cachedInputPerMillion: managed.cachedInputPerMillion,
  };

  // Kortix-cloud: managed models route to AWS Bedrock (the platform's own key).
  if (config.AWS_BEDROCK_API_KEY) {
    return {
      provider: 'bedrock',
      kind: 'bedrock',
      baseUrl: bedrockBaseUrl(),
      apiKey: config.AWS_BEDROCK_API_KEY,
      billingMode: 'credits',
      markup: llmPriceMarkup(),
      resolvedModel: managed.bedrockModelId,
      pricing,
    };
  }

  // Self-host / no Bedrock: fall back to OpenRouter for the managed catalog so a
  // self-hoster with only OPENROUTER_API_KEY still gets the curated models.
  if (config.OPENROUTER_API_KEY) {
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
      pricing,
    };
  }

  return null;
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
