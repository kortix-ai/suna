import { beforeAll, describe, expect, it } from 'bun:test';
import {
  isDaytonaTransientProviderError,
  primeDaytonaTransientClassifier,
} from '../shared/daytona-transient';

// Real SDK classes — same shape prod throws. Imported here so the classifier's
// instanceof path (the strongest signal) is exercised against the genuine
// classes, not mocks. The classifier's name/statusCode/message fallbacks are
// also exercised separately (see "without instanceof" cases).
import {
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from '@daytonaio/sdk';

beforeAll(async () => {
  await primeDaytonaTransientClassifier();
});

// Regression for Better Stack pattern `e98d61f1…`
// `DaytonaError` with message `<html>…<h1>502 Bad Gateway</h1>…</html>`
// (Kortix API prod, application_id 2346961). When the Daytona API gateway
// 502s with an HTML error page, the SDK's `extractAxiosErrorMessage` falls
// through to `error.response.data` (the raw HTML string), and
// `errorClassFromStatusCode(502)` returns the generic `DaytonaError` (502 is
// NOT in the SDK's STATUS_CODE_TO_ERROR map). The result is a generic
// `DaytonaError` with `statusCode === 502` and the HTML body as its message
// — exactly the shape that paged Sentry from an unguarded call site. This
// test proves the classifier recognizes that shape so `app.onError` can
// downgrade it to a retryable 503 without paging Sentry.

describe('isDaytonaTransientProviderError', () => {
  describe('positive cases (transient provider failures)', () => {
    it('matches the exact prod 502-HTML-body fingerprint (generic DaytonaError, statusCode 502)', () => {
      // The exact shape Better Stack records for `e98d61f1…`:
      //   type: DaytonaError
      //   message: <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n
      //   statusCode: 502
      //   errorCode: undefined
      const html502Body =
        '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n';
      const err = new DaytonaError(html502Body, 502);
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a generic DaytonaError with statusCode 503 (service unavailable)', () => {
      const err = new DaytonaError('Service Unavailable', 503);
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a generic DaytonaError with statusCode 504 (gateway timeout)', () => {
      const err = new DaytonaError('Gateway Timeout', 504);
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a real DaytonaTimeoutError (instanceof path)', () => {
      const err = new DaytonaTimeoutError('Operation timed out', undefined);
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a real DaytonaConnectionError (instanceof path)', () => {
      const err = new DaytonaConnectionError('socket hang up', undefined);
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a DaytonaTimeoutError by name (no instanceof, no statusCode)', () => {
      // A re-thrown / re-wrapped error that lost its class identity but kept
      // the SDK class name. The SDK sets `this.name = new.target.name`, so a
      // `DaytonaTimeoutError` always has `name === 'DaytonaTimeoutError'`.
      const err = new Error('Operation timed out');
      err.name = 'DaytonaTimeoutError';
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a DaytonaConnectionError by name (no instanceof, no statusCode)', () => {
      const err = new Error('socket connection closed');
      err.name = 'DaytonaConnectionError';
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a generic DaytonaError with a connection-failure message substring', () => {
      // The SDK wraps axios network errors into a generic DaytonaError when it
      // can't classify them — `socket hang up`, `ECONNRESET`, `ETIMEDOUT`, …
      // are all transient.
      const err = new DaytonaError('socket hang up');
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });

    it('matches a generic DaytonaError with an ECONNRESET message', () => {
      const err = new DaytonaError('read ECONNRESET');
      expect(isDaytonaTransientProviderError(err)).toBe(true);
    });
  });

  describe('negative cases (NOT transient provider failures — must stay loud)', () => {
    it('does NOT match a DaytonaRateLimitError (429 — owned by isDaytonaRateLimitError)', () => {
      // The 429 throttler is owned by the sibling classifier
      // `isDaytonaRateLimitError` (shared/daytona-rate-limit.ts). It has its
      // own Retry-After semantics and must NOT be matched here — otherwise the
      // two classifiers would both fire and the more-specific 429 branch could
      // be shadowed.
      const err = new DaytonaRateLimitError(
        'ThrottlerException: Too Many Requests',
        429,
        undefined,
        'ThrottlerException',
      );
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a DaytonaNotFoundError (404 — a real, different failure)', () => {
      // A 404 missing-box is an unexpected failure for a live call site (the
      // box should exist) — it must still fall through to the generic capture
      // so it stays loud. The classifier is scoped to transient gateway /
      // connection / timeout failures ONLY.
      const err = new DaytonaNotFoundError('Sandbox not found', 404);
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a DaytonaValidationError (400 — a real client bug)', () => {
      const err = new DaytonaValidationError('Invalid snapshot name', 400);
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a generic DaytonaError with no statusCode and no transient message', () => {
      // A bare DaytonaError with neither a transient status code NOR a
      // transient message substring is NOT classified — it might be a real
      // unexpected 5xx with a JSON body, an auth failure, or a disk-quota
      // error. Let it fall through to Sentry.
      const err = new DaytonaError('total disk limit exceeded');
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a DaytonaError with a 500 statusCode (unexpected 5xx, not gateway-class)', () => {
      // 500 is "internal server error" — NOT a transient gateway blip. The
      // classifier only matches 502/503/504 (gateway / unavailable / timeout).
      // A Daytona 500 is a real upstream bug that should stay loud.
      const err = new DaytonaError('internal server error', 500);
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a generic HTTP 502 from a non-Daytona upstream', () => {
      // A bare Error with `statusCode === 502` is intentionally NOT enough —
      // a non-Daytona upstream (LLM gateway, GitHub, Stripe, …) could 502 too.
      // The classifier requires a Daytona-specific signal (the `DaytonaError`
      // class name OR a Daytona-typed connection/timeout message substring).
      const err = new Error('upstream returned 502') as Error & { statusCode?: number };
      err.statusCode = 502;
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a generic HTTP 503 from a non-Daytona upstream', () => {
      const err = new Error('Service Unavailable') as Error & { statusCode?: number };
      err.statusCode = 503;
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match a plain Error with a "gateway" message but no Daytona signal', () => {
      // A bare Error with "gateway" in the message is too broad — it could be
      // any gateway. Require the `DaytonaError` class name.
      const err = new Error('API gateway is down');
      expect(isDaytonaTransientProviderError(err)).toBe(false);
    });

    it('does NOT match non-error inputs (null, undefined, primitives, plain objects)', () => {
      expect(isDaytonaTransientProviderError(null)).toBe(false);
      expect(isDaytonaTransientProviderError(undefined)).toBe(false);
      expect(isDaytonaTransientProviderError('502 Bad Gateway')).toBe(false);
      expect(isDaytonaTransientProviderError(502)).toBe(false);
      expect(isDaytonaTransientProviderError({ message: 'socket hang up' })).toBe(false);
      expect(isDaytonaTransientProviderError({ statusCode: 502, name: 'DaytonaError' })).toBe(
        false,
      );
    });
  });
});
