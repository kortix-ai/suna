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
import type { InflightBudget } from './inflight-budget';

export type AdmittedBodyResult =
  | { ok: true; body: string; bytes: number; release: () => void }
  | {
      ok: false;
      reason: 'too_large' | 'overloaded';
      bytes: number;
      limit: number;
      retryAfterSeconds?: number;
    };

function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read a body while its memory is reserved, not before.
 *
 * A declared body reserves its full size before the first read. A chunked body
 * starts at zero and grows its lease before each chunk is retained. This closes
 * the gap where many concurrent requests could all allocate their bodies and
 * only then compete for the in-flight budget.
 */
export async function readAdmittedBody(
  request: Request,
  maxBytes: number,
  budget: InflightBudget,
): Promise<AdmittedBodyResult> {
  const declared = declaredContentLength(request);
  if (declared !== null && maxBytes > 0 && declared > maxBytes) {
    return { ok: false, reason: 'too_large', bytes: declared, limit: maxBytes };
  }

  const lease = budget.admit(declared ?? 0);
  if (!lease.ok) {
    return {
      ok: false,
      reason: lease.reason,
      bytes: declared ?? 0,
      limit: maxBytes,
      ...(lease.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: lease.retryAfterSeconds }
        : {}),
    };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, body: '', bytes: 0, release: lease.release };
  }

  // Bytes are retained as bytes and decoded to ONE string at the end. The
  // previous implementation decoded every chunk to a string and then
  // `join`ed them, which held two full copies of the body (the parts and the
  // joined result) at the moment of the join. Here a declared body lands in a
  // single preallocated buffer (each network chunk is released as soon as it
  // is copied), and an undeclared body is concatenated once. Peak is one
  // byte buffer plus the decoded string, and the buffer is a local that dies
  // on return.
  let buffer: Uint8Array | null =
    declared !== null && declared > 0 && (maxBytes <= 0 || declared <= maxBytes)
      ? new Uint8Array(declared)
      : null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextBytes = bytes + value.byteLength;
      if (maxBytes > 0 && nextBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        lease.release();
        return { ok: false, reason: 'too_large', bytes: nextBytes, limit: maxBytes };
      }
      const resized = lease.resize(nextBytes);
      if (!resized.ok) {
        await reader.cancel().catch(() => {});
        lease.release();
        return {
          ok: false,
          reason: resized.reason,
          bytes: nextBytes,
          limit: maxBytes,
          ...(resized.reason === 'overloaded' ? { retryAfterSeconds: 1 } : {}),
        };
      }
      if (buffer && nextBytes <= buffer.byteLength) {
        buffer.set(value, bytes);
      } else {
        // `content-length` lied (or was absent): fall back to chunk collection.
        if (buffer) {
          chunks.push(buffer.subarray(0, bytes));
          buffer = null;
        }
        chunks.push(value);
      }
      bytes = nextBytes;
    }
    let whole: Uint8Array;
    if (buffer) {
      whole = bytes === buffer.byteLength ? buffer : buffer.subarray(0, bytes);
    } else if (chunks.length === 1) {
      whole = chunks[0];
    } else {
      whole = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        whole.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    chunks.length = 0;
    buffer = null;
    return { ok: true, body: new TextDecoder().decode(whole), bytes, release: lease.release };
  } catch (error) {
    lease.release();
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

/** Keep an admission lease until the response body finishes or is cancelled. */
export function releaseWhenResponseEnds(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
