import type { ProviderKind } from '../domain';
import { buildAnthropicRequest, translateAnthropicResponse } from './anthropic';
import { buildBedrockRequest, translateBedrockResponse } from './bedrock';
import { buildUpstreamRequest } from './openai-compat';
import { buildResponsesRequest, translateResponsesResponse } from './openai-responses';
import type { Transport } from './transport';

const openaiCompat: Transport = {
  buildRequest: buildUpstreamRequest,
  translateResponse: (response) => response,
};

const openaiResponses: Transport = {
  buildRequest: buildResponsesRequest,
  translateResponse: translateResponsesResponse,
};

const anthropic: Transport = {
  buildRequest: buildAnthropicRequest,
  translateResponse: translateAnthropicResponse,
};

const bedrock: Transport = {
  buildRequest: buildBedrockRequest,
  translateResponse: translateBedrockResponse,
};

const registry: Record<ProviderKind, Transport> = {
  'openai-compat': openaiCompat,
  'openai-responses': openaiResponses,
  anthropic,
  bedrock,
  custom: openaiCompat,
};

export function transportFor(kind: ProviderKind): Transport {
  return registry[kind] ?? openaiCompat;
}
