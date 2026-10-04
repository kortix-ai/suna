/**
 * A reconnect mints a NEW GitHub installation id for the same owner, and
 * nothing used to remove the old row: `upsertAccountGitHubInstallation`
 * conflicts on `(account_id, installation_id)` only. The list then returned two
 * rows with identical labels, `/new` defaulted to one of them, and minting a
 * token for the dead one answered `404` — which became "This GitHub connection
 * is no longer valid. Reconnect it in Settings → Git." to a user who had just
 * reconnected.
 *
 * Verified against GitHub on 2026-09-25: the retired id answered `404 Not
 * Found` on `POST /app/installations/<id>/access_tokens` while the current id
 * answered `201`.
 *
 * So a 404 on that endpoint is proof the row is dead. Drop it and continue with
 * another connection for the same owner. Pure over its dependencies: no
 * database and no network here.
 */
import { describe, expect, mock, test } from 'bun:test';

import { mintInstallationTokenHealing, type HealableInstallation } from './installation-healing';

function unreachable(installationId: string) {
  // The shape `isGitHubInstallationUnreachable` matches — GitHubApiError is not
  // imported here on purpose (see github-installation-errors.ts on import edges).
  return Object.assign(new Error(`GitHub /app/installations/${installationId}/access_tokens failed (404): Not Found`), {
    name: 'GitHubApiError',
    status: 404,
    path: `/app/installations/${installationId}/access_tokens`,
  });
}

function row(installationId: string, ownerLogin = 'octo-person'): HealableInstallation {
  return { installationId, ownerLogin };
}

describe('mintInstallationTokenHealing', () => {
  test('a live installation mints once and drops nothing', async () => {
    const mint = mock(async () => ({ token: 'ghs_live' }));
    const dropInstallation = mock(async () => {});
    const siblings = mock(async () => []);

    const result = await mintInstallationTokenHealing(row('200'), {
      accountId: 'acc-1',
      mint,
      dropInstallation,
      siblings,
    });

    expect(result.token).toBe('ghs_live');
    expect(result.installation.installationId).toBe('200');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(dropInstallation).not.toHaveBeenCalled();
    expect(siblings).not.toHaveBeenCalled();
  });

  test('a dead installation is deleted and the live sibling answers instead', async () => {
    const mint = mock(async (installationId: string) => {
      if (installationId === 'dead') throw unreachable('dead');
      return { token: 'ghs_live' };
    });
    const dropInstallation = mock(async (_accountId: string, _installationId: string) => {});
    const siblings = mock(async (_accountId: string, _ownerLogin: string) => [row('live')]);

    const result = await mintInstallationTokenHealing(row('dead'), {
      accountId: 'acc-1',
      mint,
      dropInstallation,
      siblings,
    });

    expect(result.token).toBe('ghs_live');
    expect(result.installation.installationId).toBe('live');
    expect(dropInstallation).toHaveBeenCalledTimes(1);
    expect(dropInstallation.mock.calls[0]).toEqual(['acc-1', 'dead']);
    // The owner is what makes a sibling a valid substitute — never another owner.
    expect(siblings.mock.calls[0]).toEqual(['acc-1', 'octo-person']);
  });

  test('every dead row is dropped, and the original failure stands when none is live', async () => {
    const mint = mock(async (installationId: string) => {
      throw unreachable(installationId);
    });
    const dropped: string[] = [];
    const dropInstallation = mock(async (_accountId: string, installationId: string) => {
      dropped.push(installationId);
    });
    const siblings = mock(async () => [row('older-dead')]);

    const promise = mintInstallationTokenHealing(row('dead'), {
      accountId: 'acc-1',
      mint,
      dropInstallation,
      siblings,
    });

    await expect(promise).rejects.toMatchObject({ status: 404 });
    expect(dropped).toEqual(['dead', 'older-dead']);
  });

  test('a failure that is not a dead installation is rethrown and deletes nothing', async () => {
    const rateLimited = Object.assign(new Error('GitHub /app/installations/1/access_tokens failed (403)'), {
      name: 'GitHubApiError',
      status: 403,
      path: '/app/installations/1/access_tokens',
    });
    const mint = mock(async () => {
      throw rateLimited;
    });
    const dropInstallation = mock(async () => {});

    await expect(
      mintInstallationTokenHealing(row('1'), {
        accountId: 'acc-1',
        mint,
        dropInstallation,
        siblings: async () => [row('2')],
      }),
    ).rejects.toBe(rateLimited);
    // A 403, a timeout or a 5xx says nothing about whether the row is valid.
    expect(dropInstallation).not.toHaveBeenCalled();
  });

  test('a sibling is tried at most once each — no loop on a repeatedly dead account', async () => {
    const attempted: string[] = [];
    const mint = mock(async (installationId: string) => {
      attempted.push(installationId);
      throw unreachable(installationId);
    });

    await expect(
      mintInstallationTokenHealing(row('a'), {
        accountId: 'acc-1',
        mint,
        dropInstallation: async () => {},
        siblings: async () => [row('b'), row('c'), row('a')],
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(attempted).toEqual(['a', 'b', 'c']);
  });
});
