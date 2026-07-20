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
  /**
   * Every REMAINING field of the upstream's `error` object, verbatim, minus
   * `message`/`code` above. Upstreams put the actually-actionable part of a
   * rejection here — OpenAI-shaped backends use `type`/`param` to name the
   * offending field — and dropping it collapses a specific, fixable error into
   * an unactionable one. That cost real debugging time: every Codex request
   * 400'd with nothing in the logs but `"Bad Request"`, and finding the true
   * cause (a missing `store: false`) needed git archaeology against a deleted
   * transport rather than just reading the error. Kept as an opaque bag so any
   * upstream's extra fields survive without this type having to know them.
   */
  detail?: Record<string, unknown>;
}

/** First in-stream error frame in an SSE buffer, if any. OpenRouter (and other
 *  openai-compat upstreams) report a mid-stream upstream failure as a 200 stream
 *  carrying `data: {"error":{"message":"Upstream idle timeout exceeded",...}}` —
 *  the HTTP layer never sees a failure, so without parsing for this the gateway
 *  books a dead turn as a success.
 *
 *  Anthropic's own streaming error event uses a DIFFERENT convention for the
 *  same idea: `data: {"type":"error","error":{"type":"overloaded_error"|
 *  "rate_limit_error"|"authentication_error"|..., "message":"..."}}` — the
 *  classifying field is `error.type`, not `error.code`. Without reading it, an
 *  Anthropic-backed candidate that dies mid-stream always produced `code:
 *  undefined`, so a transient `overloaded_error` (safe to retry) was
 *  indistinguishable from an `authentication_error` (dead credential) by the
 *  time it reached the caller. `error.code` (OpenAI/OpenRouter convention) is
 *  tried first; `error.type` is only a fallback so it can never shadow a real
 *  `code` on an OpenAI-shaped frame that happens to also carry a `type`. */
export function sseErrorFrame(buffer: string): SseErrorFrame | null {
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { error?: unknown };
      const error = chunk.error;
      if (!error || typeof error !== 'object') continue;
      const { message, code, ...rest } = error as {
        message?: unknown;
        code?: unknown;
        [k: string]: unknown;
      };
      const type = rest.type;
      if (typeof message === 'string' && message.length > 0) {
        const resolvedCode =
          typeof code === 'string' || typeof code === 'number'
            ? code
            : typeof type === 'string' && type.length > 0
              ? type
              : undefined;
        // Keep every remaining field (type/param, and the responseBody/data/url
        // the ai-sdk transport threads in for @ai-sdk APICallErrors — see
        // sse.ts) so a rejection's actionable detail survives to the logs
        // instead of collapsing to a bare message. Only when non-empty, so a
        // plain {message, code} frame keeps producing exactly the old object.
        return {
          message,
          ...(resolvedCode !== undefined ? { code: resolvedCode } : {}),
          ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
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
