import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import { config } from '../../config';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { CHATGPT_CODEX_BASE_URL, CODEX_USER_AGENT, type CodexCredential } from '../credentials/codex';

export function managedDescriptor(model: string): UpstreamDescriptor {
  return {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: config.OPENROUTER_API_URL,
    apiKey: config.OPENROUTER_API_KEY,
    billingMode: 'credits',
    markup: llmPriceMarkup(),
    appName: 'Kortix',
    appReferer: config.KORTIX_URL,
    resolvedModel: model.replace(/^kortix\//, ''),
  };
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
