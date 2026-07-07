import { test, expect } from 'bun:test';
import {
  ApiError,
  AuthError,
  BillingError,
  RequestTooLargeError,
  formatBillingErrorForUI,
  isBillingError,
  parseBillingError,
} from './errors';

// ── ApiError ─────────────────────────────────────────────────────────────────

test('ApiError sets message, name, and defaults with no fields', () => {
  const err = new ApiError('boom');
  expect(err.message).toBe('boom');
  expect(err.name).toBe('ApiError');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(ApiError);
});

test('ApiError copies plain fields (status, code, details, data, detail, response, url, endpoint, timeout)', () => {
  const response = new Response(null, { status: 500 });
  const err = new ApiError('boom', {
    status: 500,
    code: 'INTERNAL',
    details: { a: 1 },
    data: { b: 2 },
    detail: 'raw detail',
    response,
    url: 'http://x.test/y',
    endpoint: '/y',
    timeout: 5000,
  });

  expect(err.status).toBe(500);
  expect(err.code).toBe('INTERNAL');
  expect(err.details).toEqual({ a: 1 });
  expect(err.data).toEqual({ b: 2 });
  expect(err.detail).toBe('raw detail');
  expect(err.response).toBe(response);
  expect(err.url).toBe('http://x.test/y');
  expect(err.endpoint).toBe('/y');
  expect(err.timeout).toBe(5000);
});

test('ApiError overrides `name` when fields.name is given (e.g. AbortError), keeping the ApiError class', () => {
  const err = new ApiError('timed out', { name: 'AbortError', timeout: 1000 });
  expect(err.name).toBe('AbortError');
  expect(err).toBeInstanceOf(ApiError);
  expect(err.timeout).toBe(1000);
});

test('ApiError overrides `stack` when fields.stack is given', () => {
  const customStack = 'CustomError: synthetic\n    at somewhere.ts:1:1';
  const err = new ApiError('boom', { stack: customStack });
  expect(err.stack).toBe(customStack);
});

test('ApiError without an explicit stack override keeps a real captured stack', () => {
  const err = new ApiError('boom');
  expect(typeof err.stack).toBe('string');
  expect(err.stack).toContain('boom');
});

test('ApiError `message` is an enumerable own property — survives JSON.stringify and object spread', () => {
  const err = new ApiError('boom', { status: 404, code: 'NOT_FOUND' });

  const json = JSON.parse(JSON.stringify(err));
  expect(json.message).toBe('boom');

  const spread = { ...err };
  expect(spread.message).toBe('boom');
});

test('ApiError message stays writable/configurable after construction', () => {
  const err = new ApiError('original');
  err.message = 'updated';
  expect(err.message).toBe('updated');
});

test('ApiError with both a `name` and `stack` override applies both without touching unrelated fields', () => {
  const err = new ApiError('boom', { name: 'AbortError', stack: 'custom-stack', status: 408 });
  expect(err.name).toBe('AbortError');
  expect(err.stack).toBe('custom-stack');
  expect(err.status).toBe(408);
  // `rest` (destructured away from name/stack) must not have leaked either
  // of them onto some other field.
  expect(err.code).toBeUndefined();
  expect(err.details).toBeUndefined();
});

// ── AuthError ────────────────────────────────────────────────────────────────

test('AuthError defaults to "Not authenticated" with code NO_SESSION', () => {
  const err = new AuthError();
  expect(err.message).toBe('Not authenticated');
  expect(err.code).toBe('NO_SESSION');
  expect(err.name).toBe('AuthError');
  expect(err).toBeInstanceOf(ApiError);
});

test('AuthError accepts a custom message but keeps the NO_SESSION code', () => {
  const err = new AuthError('session expired');
  expect(err.message).toBe('session expired');
  expect(err.code).toBe('NO_SESSION');
});

// ── BillingError ─────────────────────────────────────────────────────────────

test('BillingError carries status + detail and defaults message from detail.message', () => {
  const err = new BillingError(402, { message: 'insufficient credits' });
  expect(err.status).toBe(402);
  expect(err.message).toBe('insufficient credits');
  expect(err.detail).toEqual({ message: 'insufficient credits' });
  expect(err.name).toBe('BillingError');
  expect(err).toBeInstanceOf(Error);
});

test('BillingError falls back to a generic "Billing Error: <status>" when detail.message is absent', () => {
  const err = new BillingError(402, { message: '' } as any);
  expect(err.message).toBe('Billing Error: 402');
});

test('BillingError honors an explicit message override over detail.message', () => {
  const err = new BillingError(402, { message: 'from detail' }, 'explicit override');
  expect(err.message).toBe('explicit override');
});

// ── RequestTooLargeError ─────────────────────────────────────────────────────

test('RequestTooLargeError defaults to status 431 with a generic message + suggestion', () => {
  const err = new RequestTooLargeError();
  expect(err.status).toBe(431);
  expect(err.message).toBe('Request headers are too large');
  expect(err.detail.suggestion).toContain('one at a time');
  expect(err.name).toBe('RequestTooLargeError');
});

test('RequestTooLargeError accepts a custom status, detail, and message', () => {
  const err = new RequestTooLargeError(431, { message: 'too many files', suggestion: 'split it up' }, 'custom msg');
  expect(err.message).toBe('custom msg');
  expect(err.detail).toEqual({ message: 'too many files', suggestion: 'split it up' });
});

// ── parseBillingError ────────────────────────────────────────────────────────

test('parseBillingError converts a 402 (via error.status) into a BillingError', () => {
  const result = parseBillingError({ status: 402, message: 'no credits', detail: { plan: 'free' } });
  expect(result).toBeInstanceOf(BillingError);
  expect((result as BillingError).status).toBe(402);
});

test('parseBillingError reads status from error.response.status when error.status is absent', () => {
  const result = parseBillingError({ response: { status: 402, data: { detail: { message: 'card declined' } } } });
  expect(result).toBeInstanceOf(BillingError);
  expect((result as BillingError).message).toBe('card declined');
});

test('parseBillingError returns the original error unchanged for a non-402 status', () => {
  const original = { status: 500, message: 'server error' };
  const result = parseBillingError(original);
  expect(result).toBe(original as unknown as Error);
});

test('parseBillingError falls back through response.data / error.data / error.detail for the error body', () => {
  const viaData = parseBillingError({ status: 402, data: { detail: { message: 'from data.detail' } } });
  expect((viaData as BillingError).message).toBe('from data.detail');

  const viaDetail = parseBillingError({ status: 402, detail: { message: 'from detail' } });
  expect((viaDetail as BillingError).message).toBe('from detail');
});

test('parseBillingError defaults to a generic message when nothing usable is present', () => {
  const result = parseBillingError({ status: 402 });
  expect((result as BillingError).message).toBe('Billing error');
});

test('parseBillingError uses error.message when the body has no nested detail.message', () => {
  const result = parseBillingError({ status: 402, message: 'top-level message', data: {} });
  expect((result as BillingError).message).toBe('top-level message');
});

test('parseBillingError spreads extra detail fields onto the BillingError.detail', () => {
  const result = parseBillingError({
    status: 402,
    detail: { message: 'limit hit', limit: 5, plan: 'free' },
  }) as BillingError;
  expect(result.detail).toMatchObject({ message: 'limit hit', limit: 5, plan: 'free' });
});

// ── isBillingError ───────────────────────────────────────────────────────────

test('isBillingError is true only for actual BillingError instances', () => {
  expect(isBillingError(new BillingError(402, { message: 'x' }))).toBe(true);
  expect(isBillingError(new ApiError('x', { status: 402 }))).toBe(false);
  expect(isBillingError(new Error('x'))).toBe(false);
  expect(isBillingError(null)).toBe(false);
  expect(isBillingError(undefined)).toBe(false);
});

// ── formatBillingErrorForUI ──────────────────────────────────────────────────

test('formatBillingErrorForUI returns null for a non-BillingError', () => {
  expect(formatBillingErrorForUI(new ApiError('x'))).toBeNull();
  expect(formatBillingErrorForUI(new Error('x'))).toBeNull();
  expect(formatBillingErrorForUI(null)).toBeNull();
  expect(formatBillingErrorForUI('just a string')).toBeNull();
});

test('formatBillingErrorForUI recognizes a "credit" message as the credits-exhausted branch', () => {
  const err = new BillingError(402, { message: 'You are out of credits' });
  expect(formatBillingErrorForUI(err)).toEqual({
    alertTitle: 'You ran out of credits',
    alertSubtitle: 'Upgrade your plan to get more credits and continue using the AI assistant.',
  });
});

test('formatBillingErrorForUI recognizes a "balance" message as the credits-exhausted branch', () => {
  const err = new BillingError(402, { message: 'Insufficient account balance' });
  expect(formatBillingErrorForUI(err)?.alertTitle).toBe('You ran out of credits');
});

test('formatBillingErrorForUI recognizes an "insufficient" message as the credits-exhausted branch', () => {
  const err = new BillingError(402, { message: 'insufficient funds for this operation' });
  expect(formatBillingErrorForUI(err)?.alertTitle).toBe('You ran out of credits');
});

test('formatBillingErrorForUI is case-insensitive when matching the credits-exhausted keywords', () => {
  const err = new BillingError(402, { message: 'CREDIT limit reached' });
  expect(formatBillingErrorForUI(err)?.alertTitle).toBe('You ran out of credits');
});

test('formatBillingErrorForUI falls back to the generic "billing check failed" branch for any other message', () => {
  const err = new BillingError(402, { message: 'subscription is paused' });
  expect(formatBillingErrorForUI(err)).toEqual({
    alertTitle: 'Billing check failed',
    alertSubtitle: 'subscription is paused',
  });
});

test('formatBillingErrorForUI generic branch falls back to a default subtitle when detail.message is empty', () => {
  const err = new BillingError(402, { message: '' } as any);
  // With an empty detail.message, BillingError's own constructor falls back to
  // 'Billing Error: 402' for `.message`, but `.detail.message` stays '' —
  // formatBillingErrorForUI reads detail.message, not the outer .message.
  expect(formatBillingErrorForUI(err)).toEqual({
    alertTitle: 'Billing check failed',
    alertSubtitle: 'Please upgrade to continue.',
  });
});
