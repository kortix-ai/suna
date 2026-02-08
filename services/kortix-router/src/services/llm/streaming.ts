import type { TokenUsage } from '../../types/llm';

/**
 * Create a streaming proxy that passes through SSE chunks.
 * Extracts usage from the final chunk if available.
 */
export function createStreamingProxy(
  upstreamResponse: Response,
  onUsage?: (usage: TokenUsage) => void
): ReadableStream<Uint8Array> {
  const reader = upstreamResponse.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let buffer = '';

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          // Flush any remaining buffer
          if (buffer.trim()) {
            controller.enqueue(encoder.encode(buffer));
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (lines ending with \n\n)
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || ''; // Keep incomplete part in buffer

        for (const part of parts) {
          if (!part.trim()) continue;

          // Pass through the SSE event
          controller.enqueue(encoder.encode(part + '\n\n'));

          // Try to extract usage from data lines
          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);

                // Extract usage from final chunk if present (OpenRouter/OpenAI format)
                if (parsed.usage && onUsage) {
                  onUsage({
                    inputTokens: parsed.usage.prompt_tokens || 0,
                    outputTokens: parsed.usage.completion_tokens || 0,
                    totalTokens: parsed.usage.total_tokens || 0,
                    cost: parsed.usage.total_cost,
                  });
                }
              } catch {
                // Not JSON, continue
              }
            }
          }
        }
      } catch (error) {
        console.error('[LLM Streaming] Error:', error);
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

/**
 * Transform Anthropic streaming format to OpenAI SSE format.
 * Anthropic uses different event types and structure.
 */
export function createAnthropicStreamingProxy(
  upstreamResponse: Response,
  onUsage?: (usage: TokenUsage) => void
): ReadableStream<Uint8Array> {
  const reader = upstreamResponse.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let buffer = '';
  let messageId = '';
  let model = '';
  let inputTokens = 0;
  let outputTokens = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          // Send final usage if we have it
          if ((inputTokens > 0 || outputTokens > 0) && onUsage) {
            onUsage({
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;

          // Parse Anthropic event
          let eventType = '';
          let eventData = '';

          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6).trim();
            }
          }

          if (!eventData) continue;

          try {
            const data = JSON.parse(eventData);

            // Handle different Anthropic event types
            switch (eventType) {
              case 'message_start':
                messageId = data.message?.id || `msg_${Date.now()}`;
                model = data.message?.model || 'claude';
                inputTokens = data.message?.usage?.input_tokens || 0;
                break;

              case 'content_block_delta':
                if (data.delta?.type === 'text_delta' && data.delta?.text) {
                  // Convert to OpenAI format
                  const openAIChunk = {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: data.delta.text },
                        finish_reason: null,
                      },
                    ],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                }
                break;

              case 'message_delta':
                outputTokens = data.usage?.output_tokens || outputTokens;
                if (data.delta?.stop_reason) {
                  const openAIChunk = {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: data.delta.stop_reason === 'end_turn' ? 'stop' : data.delta.stop_reason,
                      },
                    ],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                }
                break;

              case 'message_stop':
                // Final event, usage callback will be called in done handler
                break;

              case 'error':
                console.error('[LLM Anthropic Streaming] Error:', data);
                break;
            }
          } catch {
            // Not JSON or parse error, skip
          }
        }
      } catch (error) {
        console.error('[LLM Anthropic Streaming] Error:', error);
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}
