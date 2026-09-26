import { describe, expect, it } from 'bun:test';
import { getBackendUrl, getPublicShareUrlForToken, getSandboxUrlForExternalId } from './url-helpers';

describe('getSandboxUrlForExternalId', () => {
  it('defaults to the OpenCode port (8000) when no port is given', () => {
    expect(getSandboxUrlForExternalId('sb-abc123')).toBe(
      `${getBackendUrl()}/p/sb-abc123/8000`,
    );
  });

  it('addresses any sandbox port when one is given — the authenticated proxy for port forwarding', () => {
    expect(getSandboxUrlForExternalId('sb-abc123', 3000)).toBe(
      `${getBackendUrl()}/p/sb-abc123/3000`,
    );
    expect(getSandboxUrlForExternalId('sb-abc123', 5173)).toBe(
      `${getBackendUrl()}/p/sb-abc123/5173`,
    );
  });
});

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
