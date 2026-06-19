import type { UpstreamDescriptor } from '../../domain';
import type { UpstreamRequest } from '../openai-compat';
import { buildAnthropicCorePayload } from '../anthropic/request';

const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildBedrockRequest(
  body: Record<string, any>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const modelId = descriptor.resolvedModel || String(body.model ?? '');
  const action = body.stream === true ? 'invoke-with-response-stream' : 'invoke';

  const payload: Record<string, unknown> = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    ...buildAnthropicCorePayload(body),
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${descriptor.apiKey}`,
  };
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/model/${modelId}/${action}`,
    headers,
    payload,
  };
}
