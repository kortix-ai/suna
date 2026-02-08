import { generateText, streamText } from 'ai';
import { getModel, getAllModels, type ModelConfig } from '../../config/models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  session_id?: string;
}

export interface LLMResult {
  success: boolean;
  text?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelConfig?: ModelConfig;
  error?: string;
}

export interface LLMStreamResult {
  success: boolean;
  stream?: AsyncIterable<string>;
  usagePromise?: Promise<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  modelConfig?: ModelConfig;
  error?: string;
}

/**
 * Generate text (non-streaming).
 */
export async function generate(request: ChatCompletionRequest): Promise<LLMResult> {
  try {
    const modelConfig = getModel(request.model);

    console.log(`[LLM] Generating with ${request.model}`);

    const result = await generateText({
      model: modelConfig.model,
      messages: request.messages,
      maxOutputTokens: request.max_tokens,
      temperature: request.temperature,
    });

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;

    console.log(`[LLM] Generated: ${inputTokens} in / ${outputTokens} out tokens`);

    return {
      success: true,
      text: result.text,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      modelConfig,
    };
  } catch (error) {
    console.error('[LLM] Generate error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stream text.
 */
export async function stream(request: ChatCompletionRequest): Promise<LLMStreamResult> {
  try {
    const modelConfig = getModel(request.model);

    console.log(`[LLM] Streaming with ${request.model}`);

    const result = streamText({
      model: modelConfig.model,
      messages: request.messages,
      maxOutputTokens: request.max_tokens,
      temperature: request.temperature,
    });

    return {
      success: true,
      stream: result.textStream,
      usagePromise: (async () => {
        const usage = await result.usage;
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        return {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      })(),
      modelConfig,
    };
  } catch (error) {
    console.error('[LLM] Stream error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Calculate cost based on token usage and model pricing.
 */
export function calculateCost(
  modelConfig: ModelConfig,
  promptTokens: number,
  completionTokens: number
): number {
  const inputCost = (promptTokens / 1_000_000) * modelConfig.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * modelConfig.outputPer1M;
  return (inputCost + outputCost) * 1.2; // 20% markup
}

// Re-export model functions
export { getModel, getAllModels } from '../../config/models';
