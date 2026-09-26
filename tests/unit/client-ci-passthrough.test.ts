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

it('keeps a gateway mount prefix when binding credentials, without doubling the API version', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    urls.push(String(url));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));
  await new Client('https://preview.test/_gateway').withBearer('test').get('/v1/models');
  await new Client('https://preview.test/_gateway').get('/health');
  await new Client('https://preview.test/v1').get('/v1/health');
  expect(urls).toEqual([
    'https://preview.test/_gateway/v1/models',
    'https://preview.test/_gateway/health',
    'https://preview.test/v1/health',
  ]);
});

it('keeps the preview gateway mount for anonymous and authenticated requests', async () => {
  const fetchMock = vi.fn(async (_url: string | URL) => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  const gateway = new Client('https://preview.example.test/_gateway');
  await gateway.get('/health');
  await gateway.withBearer('test-key').post('/v1/chat/completions', { model: 'glm-5' });
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://preview.example.test/_gateway/health');
  expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://preview.example.test/_gateway/v1/chat/completions');
});
