/**
 * KRTX-4341: while a release rolls out, the previous API tasks answer a session
 * create with `503 deploy_in_progress` (see `resolveSessionInsertFailure`). The
 * user still needs the toast, but an expected deploy window must not reach the
 * frontend error tracker as an `ApiError`.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '@kortix/sdk';
import { createTranslator, defaultUiMessages } from '../../i18n';

const errorToast = mock((_message: string, _options?: { description?: string }) => undefined);
const captureException = mock((_error: unknown, _context?: unknown) => undefined);
mock.module('../../primitives/toast', () => ({ errorToast, warningToast: mock() }));
mock.module('../../lib/telemetry', () => ({ captureException }));
const { handleApiError } = await import('./error-handler');
const t = createTranslator({ locale: 'en', messages: defaultUiMessages, namespace: 'hardcodedUi.i18nComplete' });

const UPDATING = 'An update is in progress. Try again in a moment.';
const NOTIFIED = 'Our team has been notified and is working on a fix.';

beforeEach(() => {
  errorToast.mockClear();
  captureException.mockClear();
});

test('a deploy-in-progress 503 toasts the user and is not captured', () => {
  handleApiError(new ApiError(UPDATING, { status: 503, code: 'deploy_in_progress' }), undefined, t);
  expect(captureException).not.toHaveBeenCalled();
  expect(errorToast).toHaveBeenCalledTimes(1);
  expect(errorToast.mock.calls[0]?.[0]).toBe(UPDATING);
  // Nothing was reported, so the toast must not say the team was notified.
  expect(errorToast.mock.calls[0]?.[1]?.description).toBeUndefined();
});

test('a 500 session-create failure is still captured', () => {
  handleApiError(
    new ApiError('Failed to create session', { status: 500, code: 'SESSION_CREATE_FAILED' }),
    undefined,
    t,
  );
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(errorToast.mock.calls[0]?.[1]?.description).toBe(NOTIFIED);
});

test('another 503 is still captured', () => {
  handleApiError(new ApiError('Service Unavailable', { status: 503, code: '503' }), undefined, t);
  expect(captureException).toHaveBeenCalledTimes(1);
});
