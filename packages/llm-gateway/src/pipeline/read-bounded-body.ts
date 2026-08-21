/**
 * Read a request body, refusing an oversized one BEFORE it is in memory.
 *
 * The limit used to be enforced in `handleChatCompletions`, which receives
 * `rawBody` as a string — meaning every host called `await c.req.text()` first
 * and only then asked whether the body was allowed to be that big. The guard
 * sat downstream of the allocation it existed to prevent, so it could report an
 * over-limit request but never stop one from costing the memory. On 2026-08-21
 * that is part of how the dev API reached `exit 137`.
 *
 * Two checks, in the only order that helps:
 *
 *   1. A declared `content-length` over the limit is refused with the body
 *      stream untouched — zero bytes read.
 *   2. Otherwise the body is read incrementally and abandoned the moment it
 *      crosses the limit, because `content-length` is optional and may lie.
 *
 * Returning a discriminated union rather than throwing keeps the 413 shaping
 * with the host, which owns the OpenAI- vs Anthropic-shaped error envelope.
 */
import { gatewayErrorResponse } from './error-response';

export type BoundedBodyResult =
  | { ok: true; body: string }
  | { ok: false; bytes: number; limit: number };

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  // A limit of 0 (or unset) disables the check — the documented escape hatch
  // for hosts that front the gateway with their own body limit.
  if (!maxBytes || maxBytes <= 0) return { ok: true, body: await request.text() };

  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, bytes: declared, limit: maxBytes };
  }

  const body = request.body;
  if (!body) return { ok: true, body: await request.text() };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Stop pulling and drop what we have. `cancel` releases the upstream
        // so the sender is not left writing into a socket nobody drains.
        await reader.cancel().catch(() => {});
        return { ok: false, bytes, limit: maxBytes };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock?.();
  }

  return { ok: true, body: parts.join('') };
}

/**
 * The canonical 413 for an over-limit body, shared by every ingress.
 *
 * DIGIT-FREE ON PURPOSE, and this is the reason it is a function rather than
 * something each host formats itself. 413 is terminal, but OpenCode 1.18.14+
 * decides retryability by running /429|500|502|503|504|524/i over the WHOLE
 * response body — so a byte count that merely CONTAINS "500" makes the client
 * re-upload an over-limit body five times, which is the opposite of what a size
 * limit is for. The exact sizes belong in the server log, never in this body.
 *
 * `handleChatCompletions` builds the identical envelope for the same condition;
 * both must stay digit-free together, so both now come from here.
 */
export function requestTooLargeResponse(requestId = 'req_ingress'): Response {
  return gatewayErrorResponse(413, {
    message: 'Request body exceeds the configured maximum request size',
    code: 'request_too_large',
    provider: '',
    requestedModel: '',
    resolvedModel: '',
    requestId,
    suggestion: 'Start a new session or reduce the conversation and attachment size, then retry.',
  });
}

/**
 * The canonical 503 for a gateway that is at capacity.
 *
 * Distinct from the 413 above on purpose. 413 says "this can never work, do not
 * retry"; this says "this would work if I were quieter, retry shortly". Sending
 * one when the other is true either wedges a legitimate caller in a permanent
 * retry loop or makes it give up on work that was about to succeed.
 *
 * Digit-free for the same reason as the 413: OpenCode decides retryability by
 * regexing the response body, and `retryAfterSeconds` below is the structured
 * channel for that, not prose.
 */
export function gatewayOverloadedResponse(
  retryAfterSeconds = 1,
  requestId = 'req_ingress',
): Response {
  return gatewayErrorResponse(503, {
    message: 'Gateway is at capacity for large requests; retry shortly',
    code: 'gateway_overloaded',
    provider: '',
    requestedModel: '',
    resolvedModel: '',
    requestId,
    retryAfterSeconds,
    suggestion: 'Retry after a short delay, or reduce the size of the request.',
  });
}
