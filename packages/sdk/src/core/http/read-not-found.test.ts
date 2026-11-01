import { afterEach, expect, test } from 'bun:test';
import { backendApi } from './api-client';
import { ApiError } from './api/errors';
import { configureKortix } from './config';

// A read that answers 404 is a state the reading surface renders (a folder
// that is gone, a feature the platform does not offer, a deleted session), not
// a failed action. The host's `onError` turns every report into a toast, so a
// background poll of a missing resource toasted "Not found" with no context.
// A write that answers 404 is a failed action, and still reports.

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

const send = {
  GET: () => backendApi.get('/drives/synthetic-drive/files?path=%2Fgone'),
  POST: () => backendApi.post('/connectors/projects/synthetic-project/call', {}),
  PATCH: () => backendApi.patch('/chrome/connections/synthetic-browser', {}),
  DELETE: () => backendApi.delete('/projects/synthetic-project/sessions/synthetic-session'),
} as const;

for (const [method, status, expectedReports] of [
  ['GET', 404, 0],
  ['GET', 403, 1],
  ['GET', 500, 1],
  ['POST', 404, 1],
  ['PATCH', 404, 1],
  ['DELETE', 404, 1],
] as const) {
  test(`${method} ${status} reports ${expectedReports} errors and still returns the ApiError`, async () => {
    const reports: unknown[] = [];
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'synthetic-token',
      fetch: async () => Response.json({ error: 'File or folder not found' }, { status }),
      onError: (error) => {
        reports.push(error);
      },
    });

    const result = await send[method]();

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error?.status).toBe(status);
    expect(result.error?.message).toBe('File or folder not found');
    expect(reports).toHaveLength(expectedReports);
  });
}
