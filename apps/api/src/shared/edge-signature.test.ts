import { describe, expect, test } from 'bun:test';
import { APP_EDGE_HEADERS, edgeSignature, verifyEdgeSignedRequest } from './edge-signature';

const HOST = 'dev-app-aaaaaaaaaaaaaaaa.apps.kortix.com';
const signed = (secret: string) => {
  const ts = String(Date.now());
  const request = new Request('https://dev-api.kortix.com/x?y=1', {
    headers: { 'x-kortix-app-host': HOST, 'x-kortix-app-timestamp': ts, 'x-kortix-app-signature': edgeSignature(ts, HOST, 'GET', '/x?y=1', secret) },
  });
  return [request, new URL(request.url)] as const;
};
const verify = (request: Request, url: URL, secret: string) =>
  verifyEdgeSignedRequest(request, url, { headers: APP_EDGE_HEADERS, secret, publicHost: HOST });

// Pentest M-5: a dedicated edge secret rotates as `new,old` without a gap.
describe('verifyEdgeSignedRequest secret rotation', () => {
  test('accepts a signature by any listed secret and refuses an unlisted one', () => {
    expect(verify(...signed('old-secret'), 'new-secret, old-secret')).toBe(true);
    expect(verify(...signed('new-secret'), 'new-secret, old-secret')).toBe(true);
    expect(verify(...signed('other'), 'new-secret, old-secret')).toBe(false);
    expect(verify(...signed('old-secret'), 'new-secret')).toBe(false);
  });
});
