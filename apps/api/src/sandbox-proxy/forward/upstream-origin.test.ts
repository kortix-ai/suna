import { describe, expect, test } from 'bun:test';
import { SESSION_DESKTOP_PORT, upstreamOrigin } from './upstream-origin';

describe('upstreamOrigin', () => {
  test('a dev server sees the upstream origin', () => {
    expect(upstreamOrigin(3000, 'https://3000-abc.us-east.sbx.platinum.dev/')).toBe(
      'https://3000-abc.us-east.sbx.platinum.dev',
    );
  });

  test('the session desktop sees no Origin, which voxl admits', () => {
    expect(upstreamOrigin(SESSION_DESKTOP_PORT, 'https://6901-abc.us-east.sbx.platinum.dev/')).toBeNull();
  });
});
