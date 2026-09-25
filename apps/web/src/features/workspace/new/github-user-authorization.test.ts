/**
 * Creating a repository inside a PERSONAL GitHub account needs the user's own
 * GitHub authorization: GitHub refuses `POST /user/repos` for the App
 * installation token. The server answers `409
 * github_user_authorization_required` when it has no usable token for the
 * caller, and this is what turns that into one popup and one retry instead of
 * a dead end.
 *
 * Every dependency is injected, so this suite opens no window and makes no
 * request.
 */
import { describe, expect, mock, test } from 'bun:test';

import { createRepoWithGitHubAuthorization } from './github-user-authorization';

const PAYLOAD = { account_id: 'acc-1', name: 'company' };
const PROJECT = { project_id: 'proj-1' } as never;

function authorizationRequired() {
  return Object.assign(new Error('Authorize Kortix on GitHub as octo-person'), {
    status: 409,
    code: 'github_user_authorization_required',
  });
}

describe('createRepoWithGitHubAuthorization', () => {
  test('a create that succeeds asks for nothing', async () => {
    const create = mock(async () => PROJECT);
    const requestProof = mock(async () => 'ghu_live');
    const storeToken = mock(async () => ({ ok: true as const, github_login: 'octo-person' }));

    const project = await createRepoWithGitHubAuthorization(PAYLOAD, {
      create,
      requestProof,
      storeToken,
    });

    expect(project).toBe(PROJECT);
    expect(create).toHaveBeenCalledTimes(1);
    expect(requestProof).not.toHaveBeenCalled();
    expect(storeToken).not.toHaveBeenCalled();
  });

  test('authorization required: authorize once, store it, retry the same payload', async () => {
    let attempt = 0;
    const create = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw authorizationRequired();
      return PROJECT;
    });
    const requestProof = mock(async () => 'ghu_live');
    const storeToken = mock(async (_input: { account_id: string; github_user_token: string }) => ({
      ok: true as const,
      github_login: 'octo-person',
    }));

    const project = await createRepoWithGitHubAuthorization(PAYLOAD, {
      create,
      requestProof,
      storeToken,
    });

    expect(project).toBe(PROJECT);
    expect(create).toHaveBeenCalledTimes(2);
    // The SAME payload — a retry must not create a differently-named repository.
    expect(create.mock.calls[1]?.[0]).toEqual(PAYLOAD);
    expect(storeToken.mock.calls[0]?.[0]).toEqual({
      account_id: 'acc-1',
      github_user_token: 'ghu_live',
    });
  });

  // One retry. If the server still says it has no token after a store that
  // reported success, asking again cannot help and would loop popups.
  test('a second refusal is raised, never a second popup', async () => {
    const create = mock(async () => {
      throw authorizationRequired();
    });
    const requestProof = mock(async () => 'ghu_live');
    const storeToken = mock(async () => ({ ok: true as const, github_login: 'octo-person' }));

    await expect(
      createRepoWithGitHubAuthorization(PAYLOAD, { create, requestProof, storeToken }),
    ).rejects.toMatchObject({ code: 'github_user_authorization_required' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(requestProof).toHaveBeenCalledTimes(1);
  });

  test('a cancelled popup surfaces its own message, not the server 409', async () => {
    const create = mock(async () => {
      throw authorizationRequired();
    });
    const requestProof = mock(async () => {
      throw new Error('GitHub verification was cancelled.');
    });

    await expect(
      createRepoWithGitHubAuthorization(PAYLOAD, {
        create,
        requestProof,
        storeToken: async () => ({ ok: true as const, github_login: 'octo-person' }),
      }),
    ).rejects.toThrow('GitHub verification was cancelled.');

    expect(create).toHaveBeenCalledTimes(1);
  });

  test('any other failure is raised untouched', async () => {
    const limit = Object.assign(new Error('plan limit'), {
      status: 403,
      code: 'project_limit_reached',
    });
    const create = mock(async () => {
      throw limit;
    });
    const requestProof = mock(async () => 'ghu_live');

    await expect(
      createRepoWithGitHubAuthorization(PAYLOAD, {
        create,
        requestProof,
        storeToken: async () => ({ ok: true as const, github_login: 'octo-person' }),
      }),
    ).rejects.toBe(limit);

    expect(requestProof).not.toHaveBeenCalled();
  });
});
