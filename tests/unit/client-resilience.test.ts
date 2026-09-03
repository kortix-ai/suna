import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Res,
  TransientCircuitBreaker,
  describeEdgeResponse,
  isKe2eRetryableError,
  readBreakerOptions,
  transientBreaker,
  transientRetryDelayMs,
} from '../src/core/client';
import type { Captured } from '../src/core/result';

function capturedResponse(status: number, headers: Record<string, string>): Res {
  const captured: Captured = {
    routeTemplate: 'GET /v1/test',
    req: { method: 'GET', url: 'https://example.test/v1/test', headers: {} },
    res: { status, headers, bodyText: '' },
    ms: 1,
  };
  return new Res(captured);
}

function launderedMaintenance503(): Response {
  return new Response('<html>maintenance</html>', {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'retry-after': '1',
      'x-maintenance-mode': 'blocking',
    },
  });
}

beforeEach(() => {
  transientBreaker.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  transientBreaker.reset();
});

// ---------------------------------------------------------------------------
// P3.2 (a) — exponential backoff with full jitter replaces the fixed 2s delay.
// ---------------------------------------------------------------------------

describe('transient retry backoff (P3.2)', () => {
  it('grows exponentially from a ~500ms base and caps at ~8s', () => {
    const ceilings = [1, 2, 3, 4, 5, 6].map((attempt) =>
      transientRetryDelayMs(attempt, { random: () => 1 }),
    );

    expect(ceilings).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it('applies FULL jitter — the whole window below the ceiling is reachable', () => {
    expect(transientRetryDelayMs(4, { random: () => 0 })).toBe(0);
    expect(transientRetryDelayMs(4, { random: () => 0.5 })).toBe(2_000);
    expect(transientRetryDelayMs(4, { random: () => 1 })).toBe(4_000);
  });

  it('is never the old fixed 2s for every attempt', () => {
    const fixed = [1, 2, 3].every(
      (attempt) => transientRetryDelayMs(attempt, { random: () => 0.5 }) === 2_000,
    );

    expect(fixed).toBe(false);
  });

  it('raises the floor to the edge Retry-After but never past the cap', () => {
    expect(transientRetryDelayMs(1, { retryAfterMs: 3_000, random: () => 0 })).toBe(3_000);
    expect(transientRetryDelayMs(1, { retryAfterMs: 180_000, random: () => 0 })).toBe(8_000);
  });

  it('honours the env-tunable base and cap', () => {
    expect(
      transientRetryDelayMs(3, { baseMs: 100, capMs: 1_000, random: () => 1 }),
    ).toBe(400);
    expect(
      transientRetryDelayMs(9, { baseMs: 100, capMs: 1_000, random: () => 1 }),
    ).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// P3.2 (b) — the process-wide circuit breaker.
// ---------------------------------------------------------------------------

describe('transient circuit breaker (P3.2)', () => {
  it('opens only at the threshold within the rolling window', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 3,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    breaker.record();
    expect(breaker.isOpen()).toBe(false);
    breaker.record();
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.failuresInWindow()).toBe(3);
  });

  it('closes on its own once the failures age out of the window', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 2,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    breaker.record();
    expect(breaker.isOpen()).toBe(true);

    now += 60_001;
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.failuresInWindow()).toBe(0);
  });

  it('announces exactly once per open transition', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 1,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    expect(breaker.shouldAnnounce()).toBe(true);
    expect(breaker.shouldAnnounce()).toBe(false);

    now += 60_001;
    expect(breaker.isOpen()).toBe(false);
    breaker.record();
    expect(breaker.shouldAnnounce()).toBe(true);
  });

  it('is disabled by a non-positive threshold', () => {
    const breaker = new TransientCircuitBreaker({ threshold: 0, windowMs: 60_000 });
    for (let i = 0; i < 100; i++) breaker.record();

    expect(breaker.isOpen()).toBe(false);
  });

  it('reads env-tunable thresholds with 20-in-60s defaults', () => {
    expect(readBreakerOptions({})).toEqual({ threshold: 20, windowMs: 60_000 });
    expect(
      readBreakerOptions({ KE2E_BREAKER_THRESHOLD: '5', KE2E_BREAKER_WINDOW_MS: '10000' }),
    ).toEqual({ threshold: 5, windowMs: 10_000 });
  });

  it('stops retrying and stops marking retryable once open', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KE2E_BREAKER_THRESHOLD', '2');
    vi.resetModules();
    const mod = await import('../src/core/client');
    mod.transientBreaker.reset();

    const fetchMock = vi.fn().mockImplementation(async () => launderedMaintenance503());
    vi.stubGlobal('fetch', fetchMock);

    const client = new mod.Client('https://example.test/v1').withTransientGatewayRetries(3);
    const promise = client.get('/v1/test');
    await vi.runAllTimersAsync();
    const response = await promise;

    // Threshold 2 within the window: attempt 1 records, attempt 2 records and
    // trips the breaker, so the 4-attempt budget is cut short.
    expect(fetchMock.mock.calls.length).toBeLessThan(4);
    expect(mod.transientBreaker.isOpen()).toBe(true);

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('circuit open');
    // With the breaker open the flow-level budget must not re-amplify this.
    expect(isKe2eRetryableError(error)).toBe(false);

    mod.transientBreaker.reset();
  });

  it('still marks a laundered 503 retryable while the breaker is closed', () => {
    const response = capturedResponse(503, {
      'content-type': 'text/html',
      'retry-after': '30',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).not.toContain('circuit open');
  });
});

// ---------------------------------------------------------------------------
// P3.3 — name the edge response instead of guessing at it.
// ---------------------------------------------------------------------------

describe('edge response diagnostics (P3.3)', () => {
  it('names a laundered edge maintenance 503 by its header pair', () => {
    expect(
      describeEdgeResponse(503, {
        'x-maintenance-mode': 'blocking',
        'retry-after': '60',
      }),
    ).toBe(
      '[edge-laundered status=503 x-maintenance-mode=blocking x-request-id=absent]',
    );
  });

  it('names a genuine application 5xx by its x-request-id', () => {
    expect(
      describeEdgeResponse(503, {
        'x-request-id': 'req-1',
        'content-type': 'application/json',
      }),
    ).toBe('[origin status=503 x-maintenance-mode=absent x-request-id=present]');
  });

  it('does not claim maintenance for an unlabelled edge failure', () => {
    expect(describeEdgeResponse(502, {})).toBe(
      '[edge status=502 x-maintenance-mode=absent x-request-id=absent]',
    );
  });

  it('puts the diagnostics in the thrown retry-classification message', () => {
    const response = capturedResponse(503, {
      'content-type': 'text/html',
      'retry-after': '30',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain('x-maintenance-mode=blocking');
    expect((error as Error).message).toContain('x-request-id=absent');
    expect((error as Error).message).toContain('edge-laundered');
  });

  it('reports the attempt count in an exhausted network-error throw', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = new Client('https://example.test/v1')
      .withTransientGatewayRetries(2)
      .get('/v1/test');
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error.message).toContain('after 3/3 attempt(s)');
    expect(error.message).toContain('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('service URLs with a path prefix', () => {
  it('keeps the configured path prefix through auth and retry clones', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await Client.forBaseUrl('https://preview.example/_gateway')
      .withBearer('test-token', 'TEST')
      .withTransientGatewayRetries(0)
      .get('/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://preview.example/_gateway/health');
  });

  it('does not add a prefix for a root service URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await Client.forBaseUrl('https://gateway.example/').get('/v1/models');

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://gateway.example/v1/models');
  });
});

describe('security probe paths', () => {
  it('sends encoded dot segments exactly as written', async () => {
    let receivedPath = '';
    const server = createServer((request, response) => {
      receivedPath = request.url ?? '';
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await new Client(`http://127.0.0.1:${port}/v1`).get(
        '/%2e%2e/%2e%2e/etc/passwd',
        { pathAsIs: true },
      );

      expect(response.statusCode).toBe(404);
      expect(receivedPath).toBe('/%2e%2e/%2e%2e/etc/passwd');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
