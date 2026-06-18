import type { Transport } from './transport';
import { buildUpstreamRequest } from './openai-compat';
import { buildResponsesRequest, translateResponsesResponse } from './openai-responses';
import type { ProviderKind } from '../domain';

const openaiCompat: Transport = {
  buildRequest: buildUpstreamRequest,
  translateResponse: (response) => response,
};

const openaiResponses: Transport = {
  buildRequest: buildResponsesRequest,
  translateResponse: translateResponsesResponse,
};

const registry: Record<ProviderKind, Transport> = {
  'openai-compat': openaiCompat,
  'openai-responses': openaiResponses,
  anthropic: openaiCompat,
  custom: openaiCompat,
};

export function transportFor(kind: ProviderKind): Transport {
  return registry[kind] ?? openaiCompat;
}
