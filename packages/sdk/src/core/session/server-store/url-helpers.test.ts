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
