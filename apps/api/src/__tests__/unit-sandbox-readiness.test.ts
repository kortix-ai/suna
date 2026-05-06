import { afterEach, describe, expect, mock, test } from 'bun:test';
import { probeJustAvpsSandboxReadiness } from '../platform/services/sandbox-readiness';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('probeJustAvpsSandboxReadiness', () => {
  test('returns not ready when slug is missing', async () => {
    const result = await probeJustAvpsSandboxReadiness({});
    expect(result.ready).toBe(false);
    expect(result.message).toContain('slug missing');
  });

  test('does not probe backend proxy for provisioning rows', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeJustAvpsSandboxReadiness({ externalId: 'vm-123' } as any);

    expect(result.ready).toBe(false);
    expect(result.message).toContain('slug missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('treats 200 as ready', async () => {
    globalThis.fetch = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const result = await probeJustAvpsSandboxReadiness({ slug: 'abc', proxyToken: 'pt_test', serviceKey: 'sk_test' });
    expect(result.ready).toBe(true);
    expect(result.httpStatus).toBe(200);
  });

  test('treats 503 as still starting', async () => {
    globalThis.fetch = mock(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const result = await probeJustAvpsSandboxReadiness({ slug: 'abc' });
    expect(result.ready).toBe(false);
    expect(result.httpStatus).toBe(503);
  });
});
