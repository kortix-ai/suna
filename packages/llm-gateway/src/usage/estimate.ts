/**
 * Usage estimate for a stream that ended before the provider's usage frame.
 *
 * An OpenAI-compatible provider reports token usage in the LAST chunk of a
 * stream. When the client stops the stream (Stop, an agent abort, a closed
 * socket), the provider fails mid-stream, or it goes silent, that chunk never
 * arrives — but the provider has already processed the prompt and generated
 * the streamed output, and bills for both. Settling those turns as zero tokens
 * made them free. The gateway settles them from this estimate instead:
 *
 *   - prompt: the text of the request body at ~4 characters per token, plus a
 *     fixed count per inline image. Image and file bytes are never counted as
 *     text; a base64 payload would overstate the prompt by orders of magnitude.
 *   - output: the characters the provider streamed (content, reasoning, tool
 *     call arguments) at ~4 characters per token.
 *
 * The estimate prices the whole prompt as uncached input. It is recorded with
 * `usageEstimated: true` on the usage row, so it is always distinguishable
 * from provider-reported usage.
 */

/** Characters per token for mixed English prose and code. */
export const CHARS_PER_TOKEN = 4;
/** Tokens counted for one inline image or file part. */
export const IMAGE_PART_TOKENS = 1_000;

const BINARY_KEYS = new Set(['image_url', 'input_image', 'image', 'file', 'input_audio', 'file_data']);

/** An inline file (`data:` URL). Its bytes are not prompt text. */
function isBinaryString(value: string): boolean {
  return value.startsWith('data:');
}

/**
 * Estimated prompt tokens of a chat-completions request body. Walks the
 * parsed body once and counts string lengths only; allocates nothing per
 * string.
 */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  let chars = 0;
  let images = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64 || value == null) return;
    if (typeof value === 'string') {
      if (isBinaryString(value)) images += 1;
      else chars += value.length;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      chars += 1;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const type = record.type;
      if (typeof type === 'string' && BINARY_KEYS.has(type)) {
        images += 1;
        return;
      }
      for (const [key, item] of Object.entries(record)) {
        if (BINARY_KEYS.has(key) && item && typeof item === 'object') {
          images += 1;
          continue;
        }
        chars += key.length;
        visit(item, depth + 1);
      }
    }
  };
  // Only the parts a provider tokenizes as prompt.
  for (const key of ['system', 'messages', 'tools', 'functions', 'tool_choice', 'response_format']) {
    if (key in body) visit(body[key], 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_PART_TOKENS;
}

/** Estimated output tokens from the number of streamed output characters. */
export function estimateOutputTokens(outputChars: number): number {
  return outputChars > 0 ? Math.ceil(outputChars / CHARS_PER_TOKEN) : 0;
}

/** Output characters carried by one OpenAI-shaped stream chunk. */
export function chunkOutputChars(chunk: unknown): number {
  const choices = (chunk as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return 0;
  let chars = 0;
  for (const choice of choices) {
    const delta = (choice as { delta?: Record<string, unknown> } | null)?.delta;
    if (!delta || typeof delta !== 'object') continue;
    for (const key of ['content', 'reasoning', 'reasoning_content', 'refusal']) {
      const text = delta[key];
      if (typeof text === 'string') chars += text.length;
    }
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
        if (typeof fn?.name === 'string') chars += fn.name.length;
        if (typeof fn?.arguments === 'string') chars += fn.arguments.length;
      }
    }
  }
  return chars;
}
