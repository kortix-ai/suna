/**
 * `repository_disconnected` (KRTX-2955): the API answers 409 with this code
 * when the GitHub App can no longer reach a project's repository (uninstalled,
 * suspended, or the repo was removed from the App). Hosts branch on the code,
 * read the reason off the project's git connection, and fetch the reconnect
 * link from `getProjectGitConnectionState`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from './config';
import { handleErrorResponse } from './response-error';
import {
  ApiError,
  REPOSITORY_DISCONNECTED_CODE,
  isRepositoryDisconnectedError,
  repositoryDisconnectedReason,
} from './api/errors';
import { getProjectGitConnectionState } from '../rest/projects-client/github';

const body = {
  error: 'Kortix cannot reach acme/app: the Kortix GitHub App was uninstalled from acme. A GitHub owner of acme must reinstall it: Project settings → Git → Reconnect GitHub.',
  code: 'repository_disconnected',
  reason: 'app_uninstalled',
  repository: 'acme/app',
  installation_id: '7',
  install_url: null,
};

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

describe('repository_disconnected', () => {
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
    expect(result.error?.message).toBe(body.error);
    expect(REPOSITORY_DISCONNECTED_CODE).toBe('repository_disconnected');
    expect(isRepositoryDisconnectedError(result.error)).toBe(true);
  });

  test('is recognized on any error carrying the code, and nothing else', () => {
    expect(isRepositoryDisconnectedError(Object.assign(new Error('x'), { code: 'repository_disconnected' }))).toBe(true);
    expect(isRepositoryDisconnectedError(new ApiError('x', { status: 409, code: 'provision_in_flight' }))).toBe(false);
    expect(isRepositoryDisconnectedError(null)).toBe(false);
  });

  test('a git connection in the disconnected state names its reason', () => {
    expect(repositoryDisconnectedReason({ status: 'error', last_error_code: 'app_suspended' })).toBe('app_suspended');
    expect(repositoryDisconnectedReason({ status: 'error', last_error_code: 'repo_not_accessible' })).toBe('repo_not_accessible');
    expect(repositoryDisconnectedReason({ status: 'connected', last_error_code: null })).toBeNull();
    expect(repositoryDisconnectedReason({ status: 'error', last_error_code: 'push_rejected' })).toBeNull();
    expect(repositoryDisconnectedReason(null)).toBeNull();
  });

  test('getProjectGitConnectionState reads GET /projects/:id/git/connection', async () => {
    let url = '';
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'synthetic-token',
      fetch: mock(async (input: string | URL | Request) => {
        url = String(input instanceof Request ? input.url : input);
        return Response.json({
          state: 'reconnect_required',
          reason: 'repository_disconnected',
          disconnected_reason: 'app_uninstalled',
          message: body.error,
          install_url: 'https://github.com/apps/kortix/installations/new?state=s',
        });
      }) as unknown as typeof fetch,
    });
    const state = await getProjectGitConnectionState('proj-1');
    expect(url).toBe('http://backend.test/v1/projects/proj-1/git/connection');
    expect(state.state).toBe('reconnect_required');
    expect(state.disconnected_reason).toBe('app_uninstalled');
    expect(state.install_url).toContain('installations/new');
  });
});
