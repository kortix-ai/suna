// A 200 OK with syntactically valid but empty `choices`/content is a real upstream
// failure mode (seen from OpenRouter/z-ai), not a successful zero-output turn — the
// gateway must detect it so failover can try the next candidate instead of handing
// the caller a blank "stop" with no text or tool calls.

interface ChoiceLike {
  finish_reason?: unknown;
  message?: {
    content?: unknown;
    tool_calls?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
  };
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

const SOFT_RATE_LIMIT_MESSAGE =
  'Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time.';

const SOFT_RATE_LIMIT_FRAME: SseErrorFrame = {
  message: SOFT_RATE_LIMIT_MESSAGE,
  code: 429,
  detail: { type: 'soft_rate_limit' },
};

function tokenUsageValues(data: Record<string, unknown>): unknown[] {
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') return [];
  return Object.entries(usage as Record<string, unknown>)
    .filter(([key]) => key.endsWith('_tokens') || key === 'total_tokens')
    .map(([, value]) => value);
}

function hasZeroUsage(data: Record<string, unknown>): boolean {
  const values = tokenUsageValues(data);
  return values.length > 0 && values.every((value) => value === 0);
}

/**
 * Detects the exact OpenRouter ramp-rate rejection that one upstream encodes
 * as a successful assistant message. Zero usage distinguishes the rejection
 * from a model that quotes the same text in a real completion.
 */
export function jsonSoftFailureFrame(data: unknown): SseErrorFrame | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;
  if (!hasZeroUsage(body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return null;
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') return null;
  const typedChoice = choice as ChoiceLike;
  if (typedChoice.finish_reason !== 'stop') return null;
  if (typedChoice.message?.content !== SOFT_RATE_LIMIT_MESSAGE) return null;
  if (Array.isArray(typedChoice.message.tool_calls) && typedChoice.message.tool_calls.length > 0) {
    return null;
  }
  return SOFT_RATE_LIMIT_FRAME;
}

interface SseSoftFailureState {
  text: string;
  ended: boolean;
  incompatibleOutput: boolean;
  zeroUsageKnown: boolean;
  zeroUsage: boolean;
}

function sseSoftFailureState(buffer: string): SseSoftFailureState {
  let text = '';
  let ended = false;
  let incompatibleOutput = false;
  let zeroUsageKnown = false;
  let zeroUsage = true;

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      ended = true;
      continue;
    }
    try {
      const chunk = JSON.parse(payload) as Record<string, unknown> & { choices?: unknown };
      const usageValues = tokenUsageValues(chunk);
      if (usageValues.length > 0) {
        zeroUsageKnown = true;
        if (usageValues.some((value) => value !== 0)) zeroUsage = false;
      }
      if (!Array.isArray(chunk.choices)) continue;
      for (const rawChoice of chunk.choices) {
        if (!rawChoice || typeof rawChoice !== 'object') continue;
        const choice = rawChoice as ChoiceLike;
        if (typeof choice.finish_reason === 'string') ended = true;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') {
          text += delta.content;
        } else if (delta.content !== undefined && delta.content !== null) {
          incompatibleOutput = true;
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          incompatibleOutput = true;
        }
        if (
          (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) ||
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
        ) {
          incompatibleOutput = true;
        }
      }
    } catch {
      // A partial or malformed data line cannot confirm this exact signature.
    }
  }
  return { text, ended, incompatibleOutput, zeroUsageKnown, zeroUsage };
}

/**
 * Returns true while the buffered assistant text remains an exact prefix of
 * the known soft rate-limit rejection. The stream probe holds these bytes.
 */
export function sseMayContainSoftFailure(buffer: string): boolean {
  const state = sseSoftFailureState(buffer);
  if (state.incompatibleOutput) return false;
  if (state.zeroUsageKnown && !state.zeroUsage) return false;
  return SOFT_RATE_LIMIT_MESSAGE.startsWith(state.text);
}

/** Detects the complete soft rate-limit rejection in an SSE completion. */
export function sseSoftFailureFrame(buffer: string): SseErrorFrame | null {
  const state = sseSoftFailureState(buffer);
  if (
    state.incompatibleOutput ||
    !state.ended ||
    state.text !== SOFT_RATE_LIMIT_MESSAGE ||
    !state.zeroUsageKnown ||
    !state.zeroUsage
  ) {
    return null;
  }
  return SOFT_RATE_LIMIT_FRAME;
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
