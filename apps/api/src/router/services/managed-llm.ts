import { config } from '../../config';
import { buildBedrockInvokePayload, translateBedrockResponse } from './bedrock-transport';

export { resolveManagedRoute, type ManagedRoute } from './managed-route';

/**
 * Dispatch a managed Claude request to Bedrock InvokeModel and translate the
 * response back to OpenAI chat-completions shape (streaming or not). Uses the
 * Kortix-managed Bedrock credentials — managed models always run on OUR keys.
 */
export async function dispatchBedrock(
  body: Record<string, unknown>,
  isStreaming: boolean,
  bedrockModelId: string,
  traceHeaders: Record<string, string> = {},
): Promise<Response> {
  const apiKey = config.AWS_BEDROCK_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: 'AWS_BEDROCK_API_KEY is not configured', type: 'config_error' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  const region = config.AWS_BEDROCK_REGION || 'us-west-2';
  const action = isStreaming ? 'invoke-with-response-stream' : 'invoke';
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${bedrockModelId}/${action}`;
  const payload = buildBedrockInvokePayload(body);

  console.log(`[managed-llm] Bedrock InvokeModel: ${bedrockModelId} (stream=${isStreaming})`);

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...traceHeaders,
    },
    body: JSON.stringify(payload),
  });

  return translateBedrockResponse(upstream, { streaming: isStreaming });
}

// OpenCode Zen — the curated free managed models. Public/unauthenticated and
// OpenAI-compatible, so it's a plain passthrough with NO Authorization header
// and NO response translation. Never metered (billingMode 'none').
const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

/**
 * Dispatch a managed free-tier request to OpenCode Zen (openai-compatible,
 * no auth). The wire model is the Zen public model id; the response is already
 * OpenAI-shaped, so it is returned verbatim.
 */
export async function dispatchZen(
  body: Record<string, unknown>,
  zenModelId: string,
  traceHeaders: Record<string, string> = {},
): Promise<Response> {
  const forwardBody = { ...body, model: zenModelId };

  console.log(`[managed-llm] OpenCode Zen (free): ${zenModelId} (stream=${body.stream === true})`);

  return fetch(`${OPENCODE_ZEN_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // No Authorization — Zen free models are public.
      ...traceHeaders,
    },
    body: JSON.stringify(forwardBody),
  });
}
