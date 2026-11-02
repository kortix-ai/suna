/**
 * The first request field whose type the gateway would otherwise coerce in
 * silence, as a client-facing message; null when every field it reads is well
 * typed. `stream: "true"` used to mean "do not stream" and `max_tokens: -1` was
 * dropped (KRTX-3410), so an SSE client waited for events that never came.
 * A `messages` element that is not an object crashed the transports, and five
 * such requests opened a shared upstream's circuit breaker (KRTX-3421).
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
  if (body.messages != null && !(Array.isArray(body.messages) && body.messages.every(isMessage))) {
    return '`messages` must be an array of message objects';
  }
  return null;
}

/**
 * A translated chat body needs a user or assistant message. Without one the
 * request reached the model's transport: the AI SDK refused it there, an
 * OpenAI-compatible upstream answered it, and during a fallback hold the
 * fallback's upstream got it, so one body got different errors (KRTX-3421).
 * The chat handler checks it after admission, so a caller without a valid
 * token still gets its 401 first, on every ingress.
 */
export function conversationError(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((m) => isMessage(m) && (m.role === 'user' || m.role === 'assistant'))
    ? null
    : 'The request has no user or assistant message to answer.';
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
