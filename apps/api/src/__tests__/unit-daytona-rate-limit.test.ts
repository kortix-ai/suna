import { beforeAll, describe, expect, it } from 'bun:test';
import {
  isDaytonaRateLimitError,
  primeDaytonaRateLimitClassifier,
} from '../shared/daytona-rate-limit';

// Real SDK class — same shape prod throws. Imported here so the classifier's
// instanceof path (the strongest signal) is exercised against the genuine class,
// not a mock. The classifier's name/statusCode/message fallbacks are also
// exercised separately (see "without instanceof" cases).
import { DaytonaError, DaytonaNotFoundError, DaytonaRateLimitError } from '@daytonaio/sdk';

beforeAll(async () => {
  await primeDaytonaRateLimitClassifier();
});

describe('isDaytonaRateLimitError', () => {
  it('matches a real DaytonaRateLimitError (instanceof path)', () => {
    // The exact shape Better Stack records:
    // `DaytonaRateLimitError: ThrottlerException: Too Many Requests`
    const err = new DaytonaRateLimitError(
      'ThrottlerException: Too Many Requests',
      429,
      undefined,
      'ThrottlerException',
    );
    expect(isDaytonaRateLimitError(err)).toBe(true);
  });

  it('matches a DaytonaRateLimitError without errorCode (statusCode + message fallback)', () => {
    // SDK wraps the axios 429 response message into the error's `message`;
    // `errorCode` may be absent when the upstream body had no `code`/`error_code`
    // field. The 429 + `ThrottlerException` substring still identifies it.
    const err = new DaytonaRateLimitError('ThrottlerException: Too Many Requests', 429);
    expect(isDaytonaRateLimitError(err)).toBe(true);
  });

  it('matches a DaytonaRateLimitError with only the name set (no statusCode)', () => {
    // A re-thrown / re-wrapped error that lost its statusCode/errorCode but
    // kept the SDK class name. The `name === 'DaytonaRateLimitError'` fallback
    // covers this (the SDK sets `this.name = new.target.name`).
    const err = new DaytonaRateLimitError('ThrottlerException: Too Many Requests');
    expect(isDaytonaRateLimitError(err)).toBe(true);
  });

  it('matches the wrapped-message shape (`DaytonaRateLimitError: ThrottlerException: …`)', () => {
    // A plain Error whose message is the Better Stack fingerprint — covers a
    // throw new Error(`DaytonaRateLimitError: ThrottlerException: Too Many Requests`)
    // shape used in some test mocks / a rethrown wrapper.
    const err = new Error('DaytonaRateLimitError: ThrottlerException: Too Many Requests');
    expect(isDaytonaRateLimitError(err)).toBe(true);
  });

  it('does NOT match a DaytonaNotFoundError (a different, real Daytona failure)', () => {
    // 404 missing-sandbox is an EXPECTED state but a DIFFERENT failure class —
    // it must still fall through to the generic capture so unexpected Daytona
    // failures (missing boxes that should exist, archived box on a live call)
    // stay loud. The classifier is scoped to the org-wide 429 throttler ONLY.
    const err = new DaytonaNotFoundError('Sandbox not found', 404);
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });

  it('does NOT match a generic DaytonaError (no statusCode, no throttler signal)', () => {
    const err = new DaytonaError('something else went wrong');
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });

  it('does NOT match a generic HTTP 429 from a non-Daytona upstream', () => {
    // A bare 429 is too broad — it could be an LLM gateway, GitHub, Stripe, …
    // The classifier requires a Daytona-specific signal (name / errorCode /
    // ThrottlerException message), not just `statusCode === 429`.
    const err = new Error('Rate limit exceeded') as Error & { statusCode?: number };
    err.statusCode = 429;
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });

  it('does NOT match a 429 with a non-throttler errorCode', () => {
    const err = new DaytonaError('Too Many Requests', 429, undefined, 'some_other_code');
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });

  it('does NOT match a 5xx DaytonaError (outage, not rate limit)', () => {
    const err = new DaytonaError('internal server error', 503);
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });

  it('does NOT match a timeout / connection DaytonaError', () => {
    const timeout = new DaytonaError('Operation timed out', undefined);
    const conn = new DaytonaError('Connection failed', undefined);
    expect(isDaytonaRateLimitError(timeout)).toBe(false);
    expect(isDaytonaRateLimitError(conn)).toBe(false);
  });

  it('does NOT match non-error inputs (null, undefined, primitives)', () => {
    expect(isDaytonaRateLimitError(null)).toBe(false);
    expect(isDaytonaRateLimitError(undefined)).toBe(false);
    expect(isDaytonaRateLimitError('DaytonaRateLimitError: ThrottlerException')).toBe(false);
    expect(isDaytonaRateLimitError({ message: 'ThrottlerException' })).toBe(false);
  });
});
