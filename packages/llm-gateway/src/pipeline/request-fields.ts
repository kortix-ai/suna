/**
 * The first request field whose type the gateway would otherwise coerce in
 * silence, as a client-facing message; null when every field it reads is well
 * typed. `stream: "true"` used to mean "do not stream" and `max_tokens: -1` was
 * dropped (KRTX-3410), so an SSE client waited for events that never came.
 * `null` stays allowed, as in OpenAI's API. Each ingress (chat completions,
 * Anthropic messages, Responses) checks its own body before translating it.
 */
export function requestFieldError(body: Record<string, unknown>): string | null {
  if (body.stream != null && typeof body.stream !== 'boolean') return '`stream` must be true or false';
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const value = body[field];
    if (value != null && !(Number.isInteger(value) && (value as number) > 0)) {
      return `\`${field}\` must be a positive integer`;
    }
  }
  return null;
}

/**
 * A chat body (and an Anthropic one) needs at least one message. Without this
 * check an empty or missing `messages` reached the model's transport, or a held
 * fallback's upstream, so one body got two different errors (KRTX-3421). Not in
 * `requestFieldError`: a Responses body has `input`, checked after translation.
 */
export function chatMessagesError(body: Record<string, unknown>): string | null {
  return Array.isArray(body.messages) && body.messages.length > 0 ? null : '`messages` must be a non-empty array';
}
