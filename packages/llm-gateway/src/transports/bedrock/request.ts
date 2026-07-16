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

  // TODO(bedrock-sigv4): the enterprise appliance authenticates Bedrock with a
  // long-lived AWS_BEDROCK_API_KEY bearer token (the v1 decision — see
  // docs/runbooks/enterprise-vpc-deployment.md). The appliance instance role
  // ALREADY holds bedrock:InvokeModel[WithResponseStream] (latent). Adding a SigV4
  // signing path here (sign the request with the instance-role credentials from
  // IMDS/env instead of a Bearer header) would let the appliance drop the bearer
  // key entirely and rely solely on IAM — no rot, no shared secret. Until then the
  // bearer key stays required for the aws-vpc target.
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
