import { afterEach, expect, test } from 'bun:test';
import { backendApi } from './api-client';
import { ApiError, isFeatureDisabledError } from './api/errors';
import { configureKortix } from './config';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

for (const [status, code, expectedReports] of [
  [403, 'feature_disabled', 0],
  [403, 'permission_denied', 1],
  [403, undefined, 1],
  [500, 'feature_disabled', 1],
] as const) {
  test(`${status} ${code ?? 'uncoded'} reports ${expectedReports} errors and preserves the refusal`, async () => {
    const reports: unknown[] = [];
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'synthetic-token',
      fetch: async () =>
        Response.json(
          {
            error: 'Reminders is not enabled for this project.',
            code,
            feature: 'reminders',
          },
          { status },
        ),
      onError: (error) => {
        reports.push(error);
      },
    });

    const result = await backendApi.get('/projects/synthetic-project/reminders');

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error?.status).toBe(status);
    expect(result.error?.message).toBe('Reminders is not enabled for this project.');
    expect(isFeatureDisabledError(result.error)).toBe(
      status === 403 && code === 'feature_disabled',
    );
    expect(reports).toHaveLength(expectedReports);
  });
}
