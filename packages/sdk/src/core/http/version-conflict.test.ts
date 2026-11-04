/**
 * `version_conflict`: a save named a version that is no longer the file's
 * (an artifact doc, a memory page). The editor that sent it owns the answer
 * (reload or keep mine), so the host's global error report stays silent.
 */
import { afterEach, expect, test } from 'bun:test';

import { configureKortix } from './config';
import { handleErrorResponse } from './response-error';
import { ApiError } from './api/errors';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

const answer = (status: number, code: string) =>
  handleErrorResponse(
    new Response(JSON.stringify({ error: 'Someone saved a newer version.', code }), { status, headers: { 'content-type': 'application/json' } }),
    new AbortController().signal,
    true,
  );

test('a 409 version_conflict is silent to onError and keeps status and code', async () => {
  const reports: unknown[] = [];
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => null, onError: (e) => void reports.push(e) });
  const result = await answer(409, 'version_conflict');
  expect(reports).toHaveLength(0);
  expect(result.error).toBeInstanceOf(ApiError);
  expect((result.error as ApiError).status).toBe(409);
  expect((result.error as ApiError).code).toBe('version_conflict');
});

test('another 409 still reports', async () => {
  const reports: unknown[] = [];
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => null, onError: (e) => void reports.push(e) });
  await answer(409, 'already_shared');
  expect(reports).toHaveLength(1);
});
