import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SecretBrokerError } from './http-broker';
import { openUpstream, type RelayTransportSeam } from './relay-transport';

/**
 * A REAL TLS upstream on loopback.
 *
 * Every assertion here is black-box against a socket, never against a mocked
 * transport. The four Bun/Node divergences already living in this feature's
 * neighbourhood (`emit('connection')` a no-op, SNICallback never firing,
 * deleting content-length leaving the response held, the inert upgrade socket)
 * all had one thing in common: they were invisible to an in-process handle
 * handoff and obvious against a real socket.
 */
let server: Server;
let port = 0;
let certPem = '';
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
/** What the upstream actually received, per request. */
let received: Array<{ chunks: Buffer[]; headers: Record<string, unknown>; url?: string; method?: string }> = [];

function makeCert(): { cert: string; key: string } {
  const dir = `/tmp/kortix-relay-test-cert`;
  spawnSync('mkdir', ['-p', dir]);
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`,
      '-days', '2', '-nodes', '-subj', '/CN=upstream.test',
      '-addext', 'subjectAltName=DNS:upstream.test',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
  return {
    cert: require('node:fs').readFileSync(`${dir}/cert.pem`, 'utf8'),
    key: require('node:fs').readFileSync(`${dir}/key.pem`, 'utf8'),
  };
}

beforeAll(async () => {
  const { cert, key } = makeCert();
  certPem = cert;
  server = createServer({ cert, key }, (req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
});

/**
 * The transport pins the RESOLVED IP — that is the DNS-rebinding guard and the
 * reason this leg uses `node:https` and not `fetch`. Loopback is a private
 * address, so a test upstream can only be reached through the documented
 * production-unset seam, which stands in for DNS exactly as `resolvePinnedAddress`
 * would and leaves every other check (policy, port pin, budgets) live.
 */
function seam(): RelayTransportSeam {
  return {
    resolveAddress: async () => ({ address: '127.0.0.1', family: 4 as const }),
    ca: certPem,
    port,
  };
}

function head(path = '/v1/things', method = 'POST') {
  return {
    url: new URL(`https://upstream.test${path}`),
    method: method as 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
  };
}

async function drain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Reset per test: several tests install their own upstream behaviour. */
beforeEach(() => {
  received = [];
  handler = (req, res) => {
    const entry = {
      chunks: [] as Buffer[],
      headers: req.headers as Record<string, unknown>,
      url: req.url,
      method: req.method,
    };
    received.push(entry);
    req.on('data', (chunk: Buffer) => entry.chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  };
});

describe('the request leg streams, with real backpressure', () => {
  test('chunks written incrementally ARRIVE incrementally at the upstream', async () => {
    received = [];
    const seen: number[] = [];
    const body: Buffer[] = [];
    let signalFirstByte!: () => void;
    const firstByteSeen = new Promise<void>((resolve) => {
      signalFirstByte = resolve;
    });
    handler = (req, res) => {
      req.on('data', (chunk: Buffer) => {
        seen.push(chunk.byteLength);
        body.push(Buffer.from(chunk));
        signalFirstByte();
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('done');
      });
    };
    // CAUSAL, not timed. An earlier version pushed three chunks 25ms apart and
    // asserted three `data` events arrived — which TCP coalescing merges into
    // one on a loaded runner, so it failed in CI while passing locally. The
    // property is not "three reads", it is "the upstream saw bytes BEFORE the
    // request body ended". So the upstream signals its first read, and the test
    // WAITS for that signal before ending the source: if `openUpstream` buffered
    // the body to completion the signal could never arrive and this times out.
    const source = new Readable({ read() {} });
    const upstreamPromise = openUpstream(head(), source, { seam: seam() });
    source.push(Buffer.from('first-'));
    await Promise.race([
      firstByteSeen,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream saw no bytes before the body ended — not streaming')), 5000),
      ),
    ]);
    source.push(Buffer.from('second-'));
    source.push(null);
    const upstream = await upstreamPromise;
    expect(await drain(upstream.body)).toEqual(Buffer.from('done'));
    // This handler consumes the request itself, so the bytes land in `body`
    // rather than in the harness's `received`.
    expect(Buffer.concat(body).toString()).toBe('first-second-');
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  test('a streamed body is framed CHUNKED, with no content-length', async () => {
    received = [];
    const source = Readable.from([Buffer.from('abc')]);
    const upstream = await openUpstream(head(), source, { seam: seam() });
    await drain(upstream.body);
    expect(received[0]?.headers['transfer-encoding']).toBe('chunked');
    expect(received[0]?.headers['content-length']).toBeUndefined();
    expect(Buffer.concat(received[0]!.chunks).toString()).toBe('abc');
  });

  test('a Buffer body sets an exact content-length', async () => {
    received = [];
    const upstream = await openUpstream(head(), Buffer.from('exactly-13-by'), { seam: seam() });
    await drain(upstream.body);
    expect(received[0]?.headers['content-length']).toBe('13');
    expect(received[0]?.headers['transfer-encoding']).toBeUndefined();
  });

  test('the pinned host header names the POLICY host, not the pinned IP', async () => {
    // The IP is where we connect; the Host header and the SNI name are what the
    // upstream and its certificate see. Confusing the two is how IP pinning
    // usually breaks TLS.
    received = [];
    const upstream = await openUpstream(head(), null, { seam: seam() });
    await drain(upstream.body);
    expect(received[0]?.headers.host).toBe('upstream.test');
  });
});

describe('the response leg streams', () => {
  test('response chunks reach the reader INCREMENTALLY, not at end-of-body', async () => {
    // CAUSAL, not timed. The upstream writes ONE event, then waits for the test
    // to actually read it before writing the last one and ending. If the
    // response were buffered to completion the reader would never see event 1,
    // the gate would never open, and this times out — which is exactly the
    // regression worth catching. Counting arrivals within a time budget is not:
    // TCP coalescing merges SSE frames on a loaded runner, which is how the
    // timed version failed in CI while passing locally.
    let openGate!: () => void;
    const firstEventRead = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"i":0}\n\n');
      void firstEventRead.then(() => {
        res.write('data: {"i":1}\n\n');
        res.end();
      });
    };
    const upstream = await openUpstream(head('/sse', 'GET'), null, { seam: seam() });
    const seenEvents: string[] = [];
    const deadline = setTimeout(() => {
      throw new Error('no event reached the reader before end-of-body — not streaming');
    }, 5000);
    for await (const chunk of upstream.body) {
      seenEvents.push(Buffer.from(chunk).toString());
      openGate();
    }
    clearTimeout(deadline);
    expect(seenEvents.join('')).toContain('{"i":0}');
    expect(seenEvents.join('')).toContain('{"i":1}');
  });

  test('the UPSTREAM status and its ordered headers come back', async () => {
    handler = (_req, res) => {
      res.writeHead(429, [
        'content-type', 'application/json',
        'retry-after', '5',
        'x-dup', 'one',
        'x-dup', 'two',
      ]);
      res.end('{}');
    };
    const upstream = await openUpstream(head('/rl', 'GET'), null, { seam: seam() });
    await drain(upstream.body);
    expect(upstream.status).toBe(429);
    expect(upstream.rawHeaders).toContainEqual(['retry-after', '5']);
    expect(upstream.rawHeaders).toContainEqual(['content-type', 'application/json']);
  });

  test('MEASURED: bun does NOT preserve duplicate non-known RESPONSE headers', async () => {
    // Pinning what is TRUE rather than what would be nice. Measured on bun
    // 1.3.14 against a raw-socket upstream emitting two literal `X-Dup:` lines:
    // `res.rawHeaders` came back holding only the LAST value, while `set-cookie`
    // (a known header) kept both. So `res.rawHeaders` does NOT give the full
    // duplicate fidelity node does — the same collapse the REQUEST leg already
    // suffers, now measured on the response leg too.
    //
    // It costs the relay nothing today: every name in SAFE_RESPONSE_HEADERS is
    // single-valued, and `set-cookie` is deliberately excluded from that list,
    // so no header that can legitimately repeat ever travels back. This test
    // exists so the day that whitelist grows a repeatable header, it fails here
    // instead of silently dropping a value in production.
    handler = (_req, res) => {
      res.writeHead(200, ['x-dup', 'one', 'x-dup', 'two']);
      res.end('{}');
    };
    const upstream = await openUpstream(head('/dup', 'GET'), null, { seam: seam() });
    await drain(upstream.body);
    const dups = upstream.rawHeaders.filter(([name]) => name === 'x-dup').map(([, v]) => v);
    expect(dups).toHaveLength(1);
    expect(dups[0]).toContain('two');
  });
});

describe('the byte budgets are the ONLY inbound guard, so they are asserted', () => {
  test('a request over the budget aborts with relay_request_too_large', async () => {
    handler = (req, res) => {
      req.on('data', () => {});
      req.on('end', () => res.end('ok'));
      req.on('error', () => {});
    };
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(4096, 0x61));
      },
    });
    const error = await openUpstream(head(), source, {
      seam: seam(),
      maxRequestBytes: 8192,
    })
      .then(async (upstream) => {
        await drain(upstream.body);
        return null;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('relay_request_too_large');
    expect((error as SecretBrokerError).status).toBe(413);
    source.destroy();
  });

  test('a response over the budget destroys the stream with relay_response_too_large', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write(Buffer.alloc(4096, 0x62)), 1);
      res.on('close', () => clearInterval(timer));
    };
    const upstream = await openUpstream(head('/big', 'GET'), null, {
      seam: seam(),
      maxResponseBytes: 8192,
    });
    const error = await drain(upstream.body).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('relay_response_too_large');
    expect((error as SecretBrokerError).status).toBe(502);
  });

  test('a budget of 0 means unlimited, for self-host operators', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(64 * 1024, 0x63));
    };
    const upstream = await openUpstream(head('/unlimited', 'GET'), null, {
      seam: seam(),
      maxResponseBytes: 0,
    });
    expect((await drain(upstream.body)).byteLength).toBe(64 * 1024);
  });
});

describe('the SSRF guard is not weakened by streaming', () => {
  test('a private destination is refused before a single byte leaves', async () => {
    // No seam: the REAL `resolvePinnedAddress` runs, and 127.0.0.1 is private.
    const error = await openUpstream(
      { url: new URL('https://127.0.0.1/v1/x'), method: 'GET', headers: {} },
      null,
      {},
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('unsafe_destination');
    expect((error as SecretBrokerError).status).toBe(403);
  });
});

describe('timeouts bound the HEADERS, never the stream', () => {
  test('a slow-to-respond upstream times out with upstream_timeout', async () => {
    handler = (_req, _res) => {
      /* never responds */
    };
    const error = await openUpstream(head('/slow', 'GET'), null, {
      seam: seam(),
      headersTimeoutMs: 150,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('upstream_timeout');
    expect((error as SecretBrokerError).status).toBe(504);
  });

  test('a stream that outlives the HEADERS timeout is NOT killed', async () => {
    // The whole point: the legacy flat 30 s `REQUEST_TIMEOUT_MS` would kill
    // every SSE stream. The headers timeout must stop counting once headers
    // arrive.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => {
        res.write('data: 2\n\n');
        res.end();
      }, 1_000);
    };
    const upstream = await openUpstream(head('/long', 'GET'), null, {
      seam: seam(),
      headersTimeoutMs: 500,
    });
    expect((await drain(upstream.body)).toString()).toBe('data: 1\n\ndata: 2\n\n');
  });
});

describe('the caller can abort a live relay', () => {
  test('aborting the client signal tears the relay body down', async () => {
    // The relay client went away mid-stream. Without this the upstream socket
    // keeps draining bytes into a substituter nobody will ever read.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('start');
      // Never ends on its own — only the abort can finish this test.
    };
    const controller = new AbortController();
    const upstream = await openUpstream(head('/abort', 'GET'), null, {
      seam: seam(),
      signal: controller.signal,
    });
    const reading = drain(upstream.body).then(
      () => 'ended',
      () => 'errored',
    );
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    // Resolves at all ⟹ the body stream was torn down by the abort. Without the
    // signal wiring this await never settles and the test times out.
    expect(['ended', 'errored']).toContain(await reading);
    expect(upstream.body.destroyed || upstream.body.readableEnded).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSIONS — each of these failed before the fix beside it.
// ═══════════════════════════════════════════════════════════════════════════

describe('the HEADERS deadline measures SILENCE, not the upload', () => {
  // `headersTimer` used to be armed the moment the request was created and
  // cleared only in the `'response'` handler. An upstream does not answer until
  // it HAS the body, so that made a flat 30 s `KORTIX_RELAY_HEADERS_TIMEOUT_MS`
  // a TOTAL-DURATION timeout on the upload leg — the exact shape this file's
  // own doc block says it avoids. It also made
  // `KORTIX_RELAY_MAX_REQUEST_BYTES` (1 GiB) unreachable on any link slower
  // than ~286 Mbit/s: the real request cap was "whatever uploads in 30 s".
  test('a body that takes LONGER than the headers timeout to upload is not killed', async () => {
    handler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(Buffer.concat(chunks).byteLength));
      });
    };
    // 8 writes × 40 ms = ~320 ms of upload against a 120 ms headers budget.
    const source = new Readable({ read() {} });
    void (async () => {
      for (let i = 0; i < 8; i += 1) {
        source.push(Buffer.from('0123456789'));
        await new Promise((r) => setTimeout(r, 40));
      }
      source.push(null);
    })();
    const upstream = await openUpstream(head('/slow-upload'), source, {
      seam: seam(),
      headersTimeoutMs: 120,
    });
    expect((await drain(upstream.body)).toString()).toBe('80');
  });

  test('the deadline still fires when the upstream goes silent AFTER the body', async () => {
    // The control: arming later must not disable the guard.
    handler = (req, _res) => {
      req.resume();
      /* never responds */
    };
    const error = await openUpstream(head('/silent'), Readable.from([Buffer.from('abc')]), {
      seam: seam(),
      headersTimeoutMs: 150,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('upstream_timeout');
  });
});

describe('EXACTLY ONE framing header reaches the upstream', () => {
  // The route's pass-through branch sets `content-length` and documents "the
  // length is PROVABLY unchanged. Forward it" — then `openUpstream` added
  // `transfer-encoding: chunked` on top without removing it. Measured on bun
  // 1.3.14: with both present Bun emits ONLY `Transfer-Encoding: chunked` and
  // silently drops the `Content-Length`, so the promise was inert and every
  // pass-through body (a 200-byte JSON POST included) went chunked — which S3
  // answers with `501 Not Implemented`. Under Node the same code emits BOTH,
  // which is a request-smuggling primitive.
  test('a caller-declared content-length is KEPT and chunked is not added', async () => {
    received = [];
    const source = Readable.from([Buffer.from('abcde')]);
    const upstream = await openUpstream(
      { ...head(), headers: { ...head().headers, 'content-length': '5' } },
      source,
      { seam: seam() },
    );
    await drain(upstream.body);
    expect(received[0]?.headers['content-length']).toBe('5');
    expect(received[0]?.headers['transfer-encoding']).toBeUndefined();
    expect(Buffer.concat(received[0]!.chunks).toString()).toBe('abcde');
  });

  test('a stream with NO declared length is chunked and carries no content-length', async () => {
    received = [];
    const source = Readable.from([Buffer.from('abc')]);
    const upstream = await openUpstream(head(), source, { seam: seam() });
    await drain(upstream.body);
    expect(received[0]?.headers['transfer-encoding']).toBe('chunked');
    expect(received[0]?.headers['content-length']).toBeUndefined();
  });

  test('a stream that OVERRUNS its declared content-length is refused, not sent', async () => {
    const source = Readable.from([Buffer.from('abcdefghij')]);
    const error = await openUpstream(
      { ...head(), headers: { ...head().headers, 'content-length': '5' } },
      source,
      { seam: seam() },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as SecretBrokerError).code).toBe('relay_request_too_large');
  });
});
