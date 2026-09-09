import { describe, expect, it } from 'bun:test';
import { getBackendUrl, getPublicShareUrlForToken } from './url-helpers';

describe('getPublicShareUrlForToken', () => {
  it('addresses the unauthenticated public-share proxy, not the authenticated one', () => {
    expect(getPublicShareUrlForToken('kps_abc123', 3000)).toBe(
      `${getBackendUrl()}/p/public-share/kps_abc123/3000`,
    );
  });

  it('never emits the authenticated /p/{sandboxId}/ shape', () => {
    const url = getPublicShareUrlForToken('kps_abc123', 3000);
    expect(url).toContain('/p/public-share/');
    expect(/\/p\/(?!public-share)/.test(url)).toBe(false);
  });
});

import { runtimeUrlForSandbox } from './url-helpers';

describe('runtimeUrlForSandbox', () => {
  const backend = 'https://api.example.com/v1';

  it('uses the per-session proxy base the backend handed out — a shared box must not be the name', () => {
    // The box holds many sessions; this base names ONE of them.
    expect(
      runtimeUrlForSandbox(
        { external_id: 'sbx_shared', base_url: 'https://api.example.com/v1/p/sess-1/8080' },
        backend,
      ),
    ).toBe('https://api.example.com/v1/p/sess-1/8080');
  });

  it('never sends the bearer to a provider box directly, whatever base_url says', () => {
    // A microVM row's base_url is the box's own edge address.
    expect(
      runtimeUrlForSandbox(
        { external_id: 'sbx_1', base_url: 'https://8000-sbx1.sbx.example/' },
        backend,
      ),
    ).toBe(`${getBackendUrl()}/p/sbx_1/8000`);
  });

  it('a proxy URL on a DIFFERENT origin is not this backend — fall back', () => {
    expect(
      runtimeUrlForSandbox(
        { external_id: 'sbx_1', base_url: 'https://evil.example/v1/p/sess-1/8080' },
        backend,
      ),
    ).toBe(`${getBackendUrl()}/p/sbx_1/8000`);
  });

  it('with no base_url it is exactly what was built before', () => {
    expect(runtimeUrlForSandbox({ external_id: 'sbx_1' }, backend)).toBe(
      `${getBackendUrl()}/p/sbx_1/8000`,
    );
    expect(runtimeUrlForSandbox({ external_id: 'sbx_1', base_url: '' }, backend)).toBe(
      `${getBackendUrl()}/p/sbx_1/8000`,
    );
  });

  it('garbage in base_url is ignored, not thrown', () => {
    expect(runtimeUrlForSandbox({ external_id: 'sbx_1', base_url: '::not a url' }, backend)).toBe(
      `${getBackendUrl()}/p/sbx_1/8000`,
    );
  });

  it('nothing to build from is an empty url — callers wait, as before a session binds', () => {
    expect(runtimeUrlForSandbox({}, backend)).toBe('');
  });
});
