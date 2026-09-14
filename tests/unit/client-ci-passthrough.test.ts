import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, CI_PASSTHROUGH_HEADER, applyCiPassthrough } from '../src/core/client';

describe('applyCiPassthrough — edge origin-status passthrough opt-in', () => {
  it('sends nothing when the secret is unset or blank', () => {
    for (const secret of [undefined, '', '   ']) {
      const h = new Headers();
      applyCiPassthrough(h, secret);
      expect(h.has(CI_PASSTHROUGH_HEADER)).toBe(false);
    }
  });

  it('sends the trimmed secret as X-Kortix-CI-Passthrough when set', () => {
    const h = new Headers();
    applyCiPassthrough(h, '  s3cret  ');
    expect(h.get(CI_PASSTHROUGH_HEADER)).toBe('s3cret');
  });

  it('never overrides a caller-supplied header value', () => {
    const h = new Headers();
    h.set(CI_PASSTHROUGH_HEADER, 'explicit');
    applyCiPassthrough(h, 'from-env');
    expect(h.get(CI_PASSTHROUGH_HEADER)).toBe('explicit');
  });
});


afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('sends the diagnostic credential but redacts it from captured artifacts', async () => {
  const secret = randomBytes(32).toString('hex');
  vi.stubEnv('KE2E_CI_PASSTHROUGH_SECRET', secret);
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get(CI_PASSTHROUGH_HEADER)).toBe(secret);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const response = await new Client('https://example.test/v1').get('/v1/health');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(response.captured.req.headers[CI_PASSTHROUGH_HEADER.toLowerCase()]).toBe(`${secret.slice(0, 6)}***[64]`);
  expect(JSON.stringify(response.captured)).not.toContain(secret);
});
