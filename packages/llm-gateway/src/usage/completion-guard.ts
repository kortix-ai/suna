// A 200 OK with syntactically valid but empty `choices`/content is a real upstream
// failure mode (seen from OpenRouter/z-ai), not a successful zero-output turn — the
// gateway must detect it so failover can try the next candidate instead of handing
// the caller a blank "stop" with no text or tool calls.

interface ChoiceLike {
  message?: { content?: unknown; tool_calls?: unknown };
  delta?: {
    content?: unknown;
    tool_calls?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
  };
}

function partHasContent(part: ChoiceLike['message'] | ChoiceLike['delta']): boolean {
  if (!part) return false;
  if (typeof part.content === 'string' && part.content.length > 0) return true;
  if (Array.isArray(part.content) && part.content.length > 0) return true;
  if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) return true;
  const reasoning = 'reasoning' in part ? part.reasoning : undefined;
  const reasoningContent = 'reasoning_content' in part ? part.reasoning_content : undefined;
  if (typeof reasoning === 'string' && reasoning.length > 0) return true;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) return true;
  return false;
}

function choiceHasContent(choice: unknown): boolean {
  if (!choice || typeof choice !== 'object') return false;
  const c = choice as ChoiceLike;
  return partHasContent(c.message) || partHasContent(c.delta);
}

/** Non-streaming completion body: real output means at least one choice with content/tool_calls. */
export function jsonHasContent(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  return choices.some(choiceHasContent);
}

export interface SseErrorFrame {
  message: string;
  code?: string | number;
}

/** First in-stream error frame in an SSE buffer, if any. OpenRouter (and other
 *  openai-compat upstreams) report a mid-stream upstream failure as a 200 stream
 *  carrying `data: {"error":{"message":"Upstream idle timeout exceeded",...}}` —
 *  the HTTP layer never sees a failure, so without parsing for this the gateway
 *  books a dead turn as a success. */
export function sseErrorFrame(buffer: string): SseErrorFrame | null {
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { error?: unknown };
      const error = chunk.error;
      if (!error || typeof error !== 'object') continue;
      const { message, code } = error as { message?: unknown; code?: unknown };
      if (typeof message === 'string' && message.length > 0) {
        return {
          message,
          ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
        };
      }
    } catch {
      // malformed SSE data line — not this function's concern, keep scanning
    }
  }
  return null;
}

/** Streaming SSE buffer (one or more `data: {...}` frames): real output means any chunk carried content. */
export function sseHasContent(buffer: string): boolean {
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { choices?: unknown };
      if (Array.isArray(chunk.choices) && chunk.choices.some(choiceHasContent)) return true;
    } catch {
      // malformed SSE data line — not this function's concern, keep scanning
    }
  }
  return false;
}
