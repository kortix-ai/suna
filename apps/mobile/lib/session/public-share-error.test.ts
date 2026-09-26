import { describe, expect, test } from 'bun:test';

import { PUBLIC_LINK_FALLBACK_ERROR, publicLinkErrorMessage } from './public-share-error';

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('publicLinkErrorMessage', () => {
  test("a 4xx with the server's sentence shows that sentence", () => {
    const message = 'Sessions using a personal connection cannot be shared publicly';
    expect(publicLinkErrorMessage(apiError(403, message))).toBe(message);
    expect(publicLinkErrorMessage(apiError(409, 'Already revoked.'))).toBe('Already revoked.');
  });

  test('a bare "HTTP 4xx: Reason" line falls back', () => {
    expect(publicLinkErrorMessage(apiError(404, 'HTTP 404: Not Found'))).toBe(PUBLIC_LINK_FALLBACK_ERROR);
  });

  test('5xx, network errors and non-errors fall back', () => {
    expect(publicLinkErrorMessage(apiError(500, 'Internal failure'))).toBe(PUBLIC_LINK_FALLBACK_ERROR);
    expect(publicLinkErrorMessage(new Error('Network request failed'))).toBe(PUBLIC_LINK_FALLBACK_ERROR);
    expect(publicLinkErrorMessage('nope')).toBe(PUBLIC_LINK_FALLBACK_ERROR);
    expect(publicLinkErrorMessage(null)).toBe(PUBLIC_LINK_FALLBACK_ERROR);
  });

  test('a 401 or an empty message falls back', () => {
    expect(publicLinkErrorMessage(apiError(401, 'Unauthorized'))).toBe(PUBLIC_LINK_FALLBACK_ERROR);
    expect(publicLinkErrorMessage(apiError(403, '   '))).toBe(PUBLIC_LINK_FALLBACK_ERROR);
  });
});
