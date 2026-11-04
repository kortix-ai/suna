/**
 * The first request field whose type the gateway would otherwise coerce in
 * silence, as a client-facing message; null when every field it reads is well
 * typed. `stream: "true"` used to mean "do not stream" and `max_tokens: -1` was
 * dropped (KRTX-3410), so an SSE client waited for events that never came.
 * A `messages` element or Responses `input` item that is not an object crashed
 * a translator or transport, and five such requests opened a shared upstream's
 * circuit breaker (KRTX-3421). `null` stays allowed, as in OpenAI's API. Each
 * ingress (chat completions, Anthropic messages, Responses) checks its own body
 * before translating it, so on those two ingresses this runs before
 * authentication (the KRTX-3410 order); on chat it runs after admission.
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
  // A Responses `input` item that is not an object threw in the translator.
  if (body.input != null && typeof body.input !== 'string' && !(Array.isArray(body.input) && body.input.every(isMessage))) {
    return '`input` must be a string or an array of input items';
  }
  // A body nested ~50,000 levels deep overflowed JSON.stringify in the translators.
  if (!fitsDepth(body)) return `The request body is nested more than ${MAX_BODY_DEPTH} levels deep`;
  return null;
}

const MAX_BODY_DEPTH = 128;

/**
 * Iterative, so the walk cannot overflow the stack itself, and one frame per
 * open container (an array is walked in place), so its memory grows with depth,
 * not with the item count: a per-item frame cost ~50x a wide body's wire bytes.
 */
function fitsDepth(value: unknown): boolean {
  const frames: { items: unknown[]; next: number }[] = [];
  const enter = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null) return true;
    if (frames.length >= MAX_BODY_DEPTH) return false;
    frames.push({ items: Array.isArray(node) ? node : Object.values(node), next: 0 });
    return true;
  };
  if (!enter(value)) return false;
  while (frames.length) {
    const top = frames[frames.length - 1]!;
    if (top.next >= top.items.length) frames.pop();
    else if (!enter(top.items[top.next++])) return false;
  }
  return true;
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
