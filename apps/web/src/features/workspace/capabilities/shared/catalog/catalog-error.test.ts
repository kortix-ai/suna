import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import { catalogErrorCopy } from './catalog-error';

describe('catalogErrorCopy', () => {
  test('a 500 is not blamed on the user connection', () => {
    // The regression this exists for. `GET /connectors/projects/:id/connectors`
    // returned 500 because a migration had not been applied locally, and the
    // page said "Check your connection and try again." — which is wrong twice
    // over: a response DID come back, and the fault was entirely server-side.
    const copy = catalogErrorCopy({ status: 500 }, testUiTranslator);
    expect(copy.description).not.toContain('connection');
    expect(copy.title).toBe('Server error');
    expect(copy.description).toContain('500');
    expect(copy.canRetry).toBe(true);
  });

  test('only a request that never completed mentions the connection', () => {
    // No status means fetch itself rejected — offline, DNS, CORS. Here the
    // user's network is a fair thing to point at, and nothing else is.
    for (const error of [new Error('Failed to fetch'), null, undefined, 'boom', {}]) {
      const copy = catalogErrorCopy(error, testUiTranslator);
      expect(copy.description).toBe('Check your connection and try again.');
      expect(copy.canRetry).toBe(true);
    }
  });

  test('Retry is withheld where pressing it cannot change the outcome', () => {
    // A Retry button that reproduces the same 403 forever is the same class of
    // lie as the wrong description — it implies the failure is transient.
    expect(catalogErrorCopy({ status: 401 }, testUiTranslator).canRetry).toBe(false);
    expect(catalogErrorCopy({ status: 403 }, testUiTranslator).canRetry).toBe(false);
    expect(catalogErrorCopy({ status: 404 }, testUiTranslator).canRetry).toBe(false);
    expect(catalogErrorCopy({ status: 422 }, testUiTranslator).canRetry).toBe(false);
    expect(catalogErrorCopy({ status: 502 }, testUiTranslator).canRetry).toBe(true);
  });

  test('permission and auth failures say which one they are', () => {
    expect(catalogErrorCopy({ status: 401 }, testUiTranslator).title).toBe('Session expired');
    expect(catalogErrorCopy({ status: 403 }, testUiTranslator).title).toBe('No access');
    expect(catalogErrorCopy({ status: 404 }, testUiTranslator).title).toBe('Not found');
  });

  test('reads status structurally, never by instanceof', () => {
    // The SDK ships an ESM build and an IIFE global, and a consumer that loads
    // both gets two distinct `ApiError` classes — `instanceof` returns false
    // for a genuine one. A plain object with a numeric `status` must work.
    expect(catalogErrorCopy({ status: 503 }, testUiTranslator).title).toBe('Server error');
    expect(catalogErrorCopy({ status: '503' }, testUiTranslator).description).toBe(
      'Check your connection and try again.',
    );
  });
});
