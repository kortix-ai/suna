/**
 * `no_workspace`: the API answers 409 with this code when the caller belongs
 * to no workspace (no account is created at sign-up any more, Workspaces D3).
 * Hosts branch on the code and show "Create a workspace or join one".
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { configureKortix } from './config';
import { handleErrorResponse } from './response-error';
import { ApiError, NO_WORKSPACE_CODE, isNoWorkspaceError } from './api/errors';

const body = {
  error: 'Create or join a workspace first.',
  message: 'Create or join a workspace first.',
  code: 'no_workspace',
  status: 409,
};

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

describe('no_workspace', () => {
  test('the 409 is silent to onError and keeps the code and the message', async () => {
    const reports: unknown[] = [];
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => null, onError: (e) => void reports.push(e) });
    const result = await handleErrorResponse(
      new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } }),
      new AbortController().signal,
      true,
    );
    expect(result.success).toBe(false);
    expect(reports).toHaveLength(0);
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error?.message).toBe('Create or join a workspace first.');
    expect(isNoWorkspaceError(result.error)).toBe(true);
  });

  test('the code is the wire value', () => {
    expect(NO_WORKSPACE_CODE).toBe('no_workspace');
  });

  test('is recognized on any error carrying the code, and nothing else', () => {
    expect(isNoWorkspaceError(new ApiError('x', { status: 409, code: 'no_workspace' }))).toBe(true);
    expect(isNoWorkspaceError(Object.assign(new Error('x'), { code: 'no_workspace' }))).toBe(true);
    expect(isNoWorkspaceError(new ApiError('x', { status: 409, code: 'provision_in_flight' }))).toBe(false);
    expect(isNoWorkspaceError(undefined)).toBe(false);
  });
});
