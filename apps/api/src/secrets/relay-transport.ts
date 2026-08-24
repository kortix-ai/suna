/**
 * The STREAMING upstream leg of the secret relay.
 *
 * ## Why `node:https` and not `fetch`
 *
 * `fetch()` cannot pin the resolved IP address. IP pinning is what makes the
 * SSRF guard resistant to DNS rebinding — `resolvePinnedAddress()` resolves the
 * hostname once, rejects private and reserved addresses, and
 * `createPinnedRequestOptions()` then connects to THAT address with the
 * hostname carried only in `servername` (SNI) and the `host` header. With
 * `fetch` the runtime resolves again, at connect time, and a name that answered
 * public a millisecond ago can answer `169.254.169.254` now. That invariant is
 * not negotiable, so this leg keeps the same primitive the buffered broker uses.
 *
 * The outbound probe measured node:http/node:https streaming under bun 1.3.14
 * as fully equivalent to fetch — incremental `req.write()`, chunked
 * transfer-encoding, incremental response `'data'` events, real TLS — and it
 * additionally hands back `res.rawHeaders`, which preserves duplicate response
 * headers that fetch's `Headers` collapses.
 *
 * `fetch` remains the right tool for the SHIM → API leg, where there is nothing
 * to pin.
 *
 * ## Timeouts
 *
 * The buffered broker's flat 30 s `REQUEST_TIMEOUT_MS` is a TOTAL-duration
 * timeout. Carried over unchanged it would kill every SSE stream at 30 s, which
 * is the exact shape of the prior gateway `idleTimeout` incident. So it is split:
 *
 *   - CONNECT   — bounded, socket-level.
 *   - HEADERS   — time until the upstream's response line arrives. Stops
 *                 counting the moment it does.
 *   - IDLE      — silence on the response socket, re-armed by every byte.
 *
 * There is deliberately NO total-duration timeout. A healthy SSE stream can run
 * for hours, and a dead one is caught by the idle timer.
 *
 * ## Byte budgets
 *
 * Enforced by counters INSIDE the read/write loops, because on bun 1.3.14 there
 * is no other guard: Bun applies no inbound flow control, a BYOB reader throws,
 * and a `CountQueuingStrategy({highWaterMark:1})` is byte-for-byte identical to
 * manual reads. See `config.ts` for the measurements.
 */
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough, Readable } from 'node:stream';
import { config } from '../config';
import {
  createPinnedRequestOptions,
  resolvePinnedAddress,
  SecretBrokerError,
} from './http-broker';

/** How long to wait for the TCP+TLS connection itself. */
export const RELAY_CONNECT_TIMEOUT_MS = 10_000;

/** The head of an outbound request — everything `prepareRelayHead` produced. */
export interface RelayRequestHead {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

export interface RelayUpstreamResponse {
  /** The UPSTREAM's status. The relay's own status is a separate concern. */
  status: number;
  /**
   * Ordered `[name, value]` pairs with DUPLICATES PRESERVED, straight from
   * `res.rawHeaders`. Names are lowercased; values are verbatim.
   */
  rawHeaders: Array<[string, string]>;
  /** The response body, streaming. Errors with a `SecretBrokerError`. */
  body: Readable;
  /** Tear the upstream down — used when the relay's own client goes away. */
  destroy(): void;
}

/**
 * TEST SEAM. Production leaves this unset, and every field exists because a
 * black-box test needs a real socket rather than a mock.
 *
 * It stands in for DNS and the trust store ONLY. The policy match, the port
 * pin, the header sanitation, the substitution and the byte budgets all stay
 * live behind it, so a test that uses the seam is still exercising the real
 * gate.
 */
export interface RelayTransportSeam {
  /** Replaces the DNS resolve + private-IP refusal. */
  resolveAddress?: (url: URL) => Promise<{ address: string; family: 4 | 6 }>;
  /** Extra CA for a self-signed loopback upstream. */
  ca?: string | string[];
  /** Loopback port, since the production path pins 443. */
  port?: number;
}

export interface OpenUpstreamOptions {
  /** The relay client's own signal (`c.req.raw.signal`) — abort propagates. */
  signal?: AbortSignal;
  /** 0 = unlimited. Defaults to `KORTIX_RELAY_MAX_REQUEST_BYTES`. */
  maxRequestBytes?: number;
  /** 0 = unlimited. Defaults to `KORTIX_RELAY_MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number;
  /** Defaults to `KORTIX_RELAY_HEADERS_TIMEOUT_MS`. */
  headersTimeoutMs?: number;
  /** 0 = off. Defaults to `KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  seam?: RelayTransportSeam;
}

/**
 * Open the upstream request and resolve as soon as its RESPONSE HEADERS arrive.
 *
 * Resolving at headers — not at end-of-body — is what makes the relay a proxy
 * rather than a buffer: the caller gets `status` + `rawHeaders` immediately, can
 * commit its own 200, and then pipes `body` through the redaction substituter
 * while the upstream is still writing.
 */
export async function openUpstream(
  head: RelayRequestHead,
  body: Readable | Buffer | null,
  options: OpenUpstreamOptions = {},
): Promise<RelayUpstreamResponse> {
  const seam = options.seam ?? {};
  const maxRequestBytes = options.maxRequestBytes ?? config.KORTIX_RELAY_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? config.KORTIX_RELAY_MAX_RESPONSE_BYTES;
  const headersTimeoutMs = options.headersTimeoutMs ?? config.KORTIX_RELAY_HEADERS_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? config.KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS;

  // Resolve and refuse BEFORE a byte leaves. Identical guard to the buffered
  // broker's — same function, so there is no second implementation to drift.
  const pinned = await (seam.resolveAddress ?? resolvePinnedAddress)(head.url);

  const requestOptions = createPinnedRequestOptions(
    { url: head.url, method: head.method as never, headers: head.headers, body: null, substituted: [], carriesSecret: false },
    pinned,
  );
  if (seam.port !== undefined) requestOptions.port = seam.port;
  if (seam.ca !== undefined) (requestOptions as { ca?: string | string[] }).ca = seam.ca;

  // Framing. The guest's own `content-length` / `transfer-encoding` never reach
  // here (both are in BLOCKED_REQUEST_HEADERS), so this is the only place the
  // upstream leg's framing is decided:
  //   - a Buffer body has a provably exact length → `content-length`
  //   - a streamed body has none → `transfer-encoding: chunked`
  // Measured: httpbin's origin, Anthropic, OpenAI, GitHub, Stripe and S3 all
  // accepted a chunked request (no 411, no 501).
  //
  // EXACTLY ONE framing header is emitted. Setting both is a request-smuggling
  // primitive under Node (which sends both) and a silent broken promise under
  // Bun 1.3.14 (measured: with both present Bun emits ONLY
  // `Transfer-Encoding: chunked` and drops the `Content-Length`). The route's
  // pass-through branch sets `content-length` because on that branch the length
  // is PROVABLY unchanged — so honour it, and enforce it in the write loop
  // below rather than letting a mismatch reach the upstream.
  const headers = { ...(requestOptions.headers as Record<string, string>) };
  const declaredLength =
    typeof headers['content-length'] === 'string' && /^\d+$/.test(headers['content-length'])
      ? Number(headers['content-length'])
      : null;
  if (Buffer.isBuffer(body)) {
    headers['content-length'] = String(body.byteLength);
    delete headers['transfer-encoding'];
  } else if (body && declaredLength !== null) {
    delete headers['transfer-encoding'];
  } else if (body) {
    delete headers['content-length'];
    headers['transfer-encoding'] = 'chunked';
  }
  requestOptions.headers = headers;

  return await new Promise<RelayUpstreamResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      request.destroy();
      reject(error);
    };

    const request = httpsRequest(requestOptions);

    // HEADERS deadline. Armed only once the REQUEST BODY IS FULLY WRITTEN, and
    // cleared the instant the response line arrives.
    //
    // Armed at request creation instead — as it was — this is a TOTAL-DURATION
    // timeout on the upload leg, which is exactly the shape this file's own doc
    // block says it avoids: an upstream does not answer until it has the body,
    // so a 200 MB PUT over a 30 Mbit sandbox link died at 30 s with
    // `504 upstream_timeout` while bytes were flowing the whole time. It also
    // made `KORTIX_RELAY_MAX_REQUEST_BYTES` (1 GiB) unreachable on any link
    // slower than ~286 Mbit/s — the real cap was "whatever uploads in 30 s".
    // `'finish'` fires on bun 1.3.14 for all three body kinds (null, Buffer,
    // stream); verified.
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    request.on('finish', () => {
      if (settled) return;
      headersTimer = setTimeout(() => {
        fail(new SecretBrokerError('upstream_timeout', 'upstream request timed out', 504));
      }, Math.max(1, headersTimeoutMs));
    });

    request.setTimeout(Math.max(1, options.connectTimeoutMs ?? RELAY_CONNECT_TIMEOUT_MS), () => {
      // `setTimeout` on a `ClientRequest` is a SOCKET-inactivity timer, so it
      // is disarmed once the response starts — otherwise it would be a second,
      // hidden total-duration timeout on the stream.
      if (settled) return;
      fail(new SecretBrokerError('upstream_timeout', 'upstream request timed out', 504));
    });

    request.on('error', (error) => {
      fail(
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('upstream_failed', 'upstream request failed', 502),
      );
    });

    const onAbort = () => {
      // The relay's client went away. Tear the upstream down rather than
      // leaving a socket draining bytes nobody will read.
      request.destroy();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('response', (response: IncomingMessage) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      clearTimeout(headersTimer);
      // Disarm the connect/inactivity timer: from here on, IDLE is the only
      // time-based control, and it is armed on the response socket below.
      request.setTimeout(0);

      const out = new PassThrough();
      let responseBytes = 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const armIdle = () => {
        if (idleTimeoutMs <= 0) return;
        clearIdle();
        idleTimer = setTimeout(() => {
          response.destroy();
          out.destroy(
            new SecretBrokerError('upstream_timeout', 'upstream stream went idle', 504),
          );
        }, idleTimeoutMs);
      };
      armIdle();

      response.on('data', (chunk: Buffer) => {
        armIdle();
        responseBytes += chunk.byteLength;
        if (maxResponseBytes > 0 && responseBytes > maxResponseBytes) {
          clearIdle();
          response.destroy();
          out.destroy(
            new SecretBrokerError(
              'relay_response_too_large',
              `upstream response exceeds ${maxResponseBytes} bytes`,
              502,
            ),
          );
          return;
        }
        // Respect the consumer: a false return means the reader is behind, so
        // stop pulling from the socket until it drains. This is the ONLY real
        // backpressure in the pipeline.
        if (!out.write(chunk)) {
          response.pause();
          out.once('drain', () => response.resume());
        }
      });
      response.on('end', () => {
        clearIdle();
        out.end();
      });
      response.on('error', (error) => {
        clearIdle();
        out.destroy(
          error instanceof SecretBrokerError
            ? error
            : new SecretBrokerError('upstream_stream_failed', 'upstream stream failed', 502),
        );
      });
      out.on('close', () => {
        clearIdle();
        options.signal?.removeEventListener('abort', onAbort);
        if (!response.readableEnded) response.destroy();
      });

      const rawHeaders: Array<[string, string]> = [];
      for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
        rawHeaders.push([response.rawHeaders[i]!.toLowerCase(), response.rawHeaders[i + 1]!]);
      }

      resolve({
        status: response.statusCode ?? 502,
        rawHeaders,
        body: out,
        destroy: () => {
          response.destroy();
          request.destroy();
        },
      });
    });

    // ── Write the request body, with REAL backpressure ────────────────────
    if (Buffer.isBuffer(body)) {
      if (maxRequestBytes > 0 && body.byteLength > maxRequestBytes) {
        fail(
          new SecretBrokerError(
            'relay_request_too_large',
            `request body exceeds ${maxRequestBytes} bytes`,
            413,
          ),
        );
        return;
      }
      request.write(body);
      request.end();
      return;
    }
    if (!body) {
      request.end();
      return;
    }

    void (async () => {
      let requestBytes = 0;
      try {
        for await (const chunk of body) {
          if (settled && request.destroyed) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          requestBytes += buffer.byteLength;
          // A caller-declared `content-length` is a promise this leg keeps.
          // Overrunning it would desynchronise the upstream's framing.
          if (declaredLength !== null && requestBytes > declaredLength) {
            fail(
              new SecretBrokerError(
                'relay_request_too_large',
                `request body exceeds its declared length of ${declaredLength} bytes`,
                413,
              ),
            );
            return;
          }
          if (maxRequestBytes > 0 && requestBytes > maxRequestBytes) {
            fail(
              new SecretBrokerError(
                'relay_request_too_large',
                `request body exceeds ${maxRequestBytes} bytes`,
                413,
              ),
            );
            return;
          }
          // `write()` returning false means the kernel buffer is full. Awaiting
          // 'drain' is what stops a fast guest from being buffered in this
          // process — the difference between a proxy and a memory sink.
          if (!request.write(buffer)) {
            await new Promise<void>((drained, failed) => {
              request.once('drain', drained);
              request.once('error', failed);
              request.once('close', () => drained());
            });
          }
        }
        if (declaredLength !== null && requestBytes !== declaredLength) {
          fail(
            new SecretBrokerError(
              'invalid_request',
              `request body is ${requestBytes} bytes but declared ${declaredLength}`,
              400,
            ),
          );
          return;
        }
        request.end();
      } catch (error) {
        fail(
          error instanceof SecretBrokerError
            ? error
            : new SecretBrokerError('upstream_failed', 'request body stream failed', 502),
        );
      }
    })();
  });
}
