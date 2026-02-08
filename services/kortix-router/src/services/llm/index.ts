import { calculateLLMCost } from '../../config';
import type { ChatCompletionRequest, LLMProxyResult, TokenUsage } from '../../types/llm';
import { getEffectiveProvider, normalizeModelId } from './providers';
import { createStreamingProxy, createAnthropicStreamingProxy } from './streaming';

/**
 * Proxy a chat completion request to the appropriate LLM provider.
 *
 * For streaming requests, returns the raw Response for passthrough.
 * For non-streaming, parses the response to extract usage for billing.
 */
export async function proxyChatCompletion(
  request: ChatCompletionRequest,
  accountId: string
): Promise<LLMProxyResult> {
  const effective = getEffectiveProvider(request.model);

  if (!effective) {
    return {
      success: false,
      error: 'No LLM provider configured. Set OPENROUTER_API_KEY in environment.',
    };
  }

  const { provider, config: providerConfig, modelId } = effective;

  try {
    // Determine endpoint
    const endpoint = provider === 'anthropic'
      ? `${providerConfig.apiUrl}/messages`
      : `${providerConfig.apiUrl}/chat/completions`;

    // Transform request if needed (e.g., Anthropic format)
    const body = providerConfig.transformRequest
      ? providerConfig.transformRequest({ ...request, model: normalizeModelId(modelId, provider) })
      : {
          ...request,
          model: normalizeModelId(modelId, provider),
          // Remove custom fields that providers don't understand
          session_id: undefined,
        };

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...providerConfig.headers,
    };

    // Add Authorization header (except for Anthropic which uses x-api-key)
    if (provider !== 'anthropic') {
      headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;
    }

    console.log(
      `[LLM] Proxying to ${provider}: ${body.model || modelId} (stream=${request.stream}, account=${accountId})`
    );

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LLM] Provider ${provider} error: ${response.status} - ${errorText.slice(0, 500)}`);

      return {
        success: false,
        error: `Provider error (${response.status}): ${errorText.slice(0, 200)}`,
        provider,
      };
    }

    // Handle streaming response
    if (request.stream) {
      let usage: TokenUsage | undefined;

      // Create appropriate streaming proxy based on provider
      const streamBody = provider === 'anthropic'
        ? createAnthropicStreamingProxy(response, (u) => { usage = u; })
        : createStreamingProxy(response, (u) => { usage = u; });

      const streamResponse = new Response(streamBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Kortix-Provider': provider,
        },
      });

      return {
        success: true,
        response: streamResponse,
        provider,
        // Usage will be extracted during streaming
      };
    }

    // Handle non-streaming response
    const data = await response.json();

    // Transform response if needed (e.g., Anthropic to OpenAI format)
    let transformedData = data;
    if (provider === 'anthropic') {
      transformedData = transformAnthropicResponse(data);
    }

    // Extract usage
    const usage = providerConfig.extractUsage?.(data);
    const cost = usage
      ? calculateLLMCost(provider, usage.inputTokens, usage.outputTokens, usage.cost)
      : 0;

    console.log(
      `[LLM] Response from ${provider}: ${usage?.inputTokens || 0} in / ${usage?.outputTokens || 0} out tokens, cost=$${cost.toFixed(6)}`
    );

    return {
      success: true,
      response: new Response(JSON.stringify(transformedData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Kortix-Provider': provider,
        },
      }),
      usage: usage
        ? { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }
        : undefined,
      provider,
    };
  } catch (error) {
    console.error(`[LLM] Proxy error for ${provider}:`, error);

    return {
      success: false,
      error: `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
      provider,
    };
  }
}

/**
 * Transform Anthropic Messages API response to OpenAI format.
 */
function transformAnthropicResponse(anthropicResponse: any): any {
  const content = anthropicResponse.content?.[0];

  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content?.type === 'text' ? content.text : '',
        },
        finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop' : anthropicResponse.stop_reason,
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

/**
 * Get list of available models.
 * Returns a curated list of popular models from configured providers.
 */
export function getAvailableModels(): Array<{ id: string; object: string; created: number; owned_by: string }> {
  const models = [
    // OpenRouter models (always available if configured)
    { id: 'openrouter/anthropic/claude-sonnet-4', owned_by: 'openrouter' },
    { id: 'openrouter/anthropic/claude-3.5-sonnet', owned_by: 'openrouter' },
    { id: 'openrouter/anthropic/claude-3-opus', owned_by: 'openrouter' },
    { id: 'openrouter/anthropic/claude-3-haiku', owned_by: 'openrouter' },
    { id: 'openrouter/openai/gpt-4o', owned_by: 'openrouter' },
    { id: 'openrouter/openai/gpt-4o-mini', owned_by: 'openrouter' },
    { id: 'openrouter/openai/o1', owned_by: 'openrouter' },
    { id: 'openrouter/openai/o1-mini', owned_by: 'openrouter' },
    { id: 'openrouter/x-ai/grok-2', owned_by: 'openrouter' },
    { id: 'openrouter/google/gemini-2.5-pro', owned_by: 'openrouter' },
    { id: 'openrouter/google/gemini-2.5-flash', owned_by: 'openrouter' },
    { id: 'openrouter/meta-llama/llama-4-maverick', owned_by: 'openrouter' },
    { id: 'openrouter/deepseek/deepseek-r1', owned_by: 'openrouter' },
    { id: 'openrouter/qwen/qwen-3-coder', owned_by: 'openrouter' },
  ];

  const now = Math.floor(Date.now() / 1000);

  return models.map((m) => ({
    id: m.id,
    object: 'model' as const,
    created: now,
    owned_by: m.owned_by,
  }));
}

// Re-export for convenience
export { getProviderFromModel, getEffectiveProvider, normalizeModelId } from './providers';
export { createStreamingProxy, createAnthropicStreamingProxy } from './streaming';
