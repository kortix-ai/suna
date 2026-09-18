import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  gitHubInstallationUnreachable,
  githubInstallationLabel,
  githubOwnerKind,
} from './github-installations';

describe('GitHub installation presentation', () => {
  /**
   * Every row this labels is a real account connection now. The instance git
   * backend used to arrive in the same list as a synthetic `pat` entry, which
   * needed both a predicate to filter it out and a second label shape; the API
   * stopped producing it, so both are gone.
   */
  test('names a connection by its GitHub owner', () => {
    expect(githubInstallationLabel('acme')).toBe('github.com/acme');
  });

  test('falls back to a usable name when the owner is unknown', () => {
    expect(githubInstallationLabel(null)).toBe('github.com/GitHub');
  });
});

describe('GitHub account connection surfaces', () => {
  // The two tests that used to live here (`keeps the GitHub App install
  // action visible during repository import`, `presents the three repository
  // sources as one visible decision`) asserted on
  // `project-create-modal.tsx`'s source. That modal — and the
  // `github-create`/`github-import` repository-source picker it alone drove —
  // was deleted along with it; `/new` only drives `POST /projects/provision`
  // (Kortix-managed repos). There is no surviving surface for either
  // assertion to move to, so they are gone, not adapted. The remaining test
  // below is independent of the deleted file.
  const accountPageSource = readFileSync(
    join(import.meta.dir, '../features/accounts/hub/account-hub-content.tsx'),
    'utf8',
  );

  test('does not gate account GitHub connections on managed-server status', () => {
    expect(accountPageSource).not.toContain("githubAppStatusQuery.data?.source === 'env'");
    expect(accountPageSource).toContain(
      '<GitHubConnectionCard account={account} canManage={canWriteAccount} />',
    );
  });
});

describe('an installation GitHub no longer resolves', () => {
  /**
   * Reported 2026-09-16: the create-project repository picker spun, then
   * printed `/app/installations/148404669/access_tokens failed (404): Not
   * Found` — GitHub's own sentence, naming an internal id, an API path and a
   * status code. The typed 409 is what lets the picker say something a person
   * can act on instead.
   */
  test('recognizes the typed 409 and carries what the retry needs', () => {
    expect(
      gitHubInstallationUnreachable({
        status: 409,
        data: {
          error: 'github_installation_unreachable',
          installation_id: '148404669',
          install_url: 'https://github.com/apps/kortix/installations/new',
        },
      }),
    ).toEqual({
      installationId: '148404669',
      installUrl: 'https://github.com/apps/kortix/installations/new',
    });
  });

  test('reads the status off `.response.status` too — both shapes reach a caller', () => {
    expect(
      gitHubInstallationUnreachable({
        response: { status: 409 },
        data: { error: 'github_installation_unreachable' },
      }),
    ).toEqual({ installationId: null, installUrl: null });
  });

  test('is null for every other failure, so they keep their own message', () => {
    expect(gitHubInstallationUnreachable(null)).toBeNull();
    expect(gitHubInstallationUnreachable(new Error('network error'))).toBeNull();
    // A 409 that is some OTHER conflict must not be relabelled as an
    // unreachable installation.
    expect(
      gitHubInstallationUnreachable({ status: 409, data: { error: 'provision_in_flight' } }),
    ).toBeNull();
    // The right slug on the wrong status is not this failure either.
    expect(
      gitHubInstallationUnreachable({
        status: 500,
        data: { error: 'github_installation_unreachable' },
      }),
    ).toBeNull();
  });
});

describe('githubOwnerKind', () => {
  test('folds GitHub account types to the two kinds the UI names', () => {
    expect(githubOwnerKind('User')).toBe('personal');
    expect(githubOwnerKind('Organization')).toBe('org');
    expect(githubOwnerKind(null)).toBeNull();
    expect(githubOwnerKind('Bot')).toBeNull();
  });
});
