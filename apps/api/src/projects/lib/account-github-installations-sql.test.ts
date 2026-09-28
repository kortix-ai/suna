/**
 * The two account-connection queries, pinned as RENDERED SQL.
 *
 * `getAccountGitHubInstallation(accountId, null)` returns the first row of the
 * list, so an unordered select makes "this account's GitHub connection" a
 * property of the heap: the same request can resolve to a different connection
 * between two calls, and a repo create can land under the wrong one. The order
 * is newest-first so a retired connection can never be the default.
 *
 * The cross-account query must also stay a COUNT. Naming the other accounts
 * that hold an installation would leak one tenant's name into another
 * tenant's picker.
 */
import { describe, expect, test } from 'bun:test';

import {
  accountGitHubInstallationsQuery,
  installationsLinkedToOtherAccountsQuery,
} from './git';

describe('accountGitHubInstallationsQuery', () => {
  const rendered = accountGitHubInstallationsQuery('account-1').toSQL().sql;

  // NEWEST first. A reconnect mints a new installation id for the same owner
  // and the retired one answers 404 on `/access_tokens`; oldest-first made that
  // dead row the default connection on `/new`, so a user who had just
  // reconnected was told to reconnect (verified on prod 2026-09-25).
  test('orders by created_at, then installation_id, newest first', () => {
    expect(rendered).toContain(
      'order by "kortix"."account_github_installations"."created_at" desc, ' +
        '"kortix"."account_github_installations"."installation_id" desc',
    );
  });

  test('is scoped to one account', () => {
    expect(rendered).toContain('"account_id" = $1');
  });
});

describe('installationsLinkedToOtherAccountsQuery', () => {
  const query = installationsLinkedToOtherAccountsQuery('account-1', ['84', '99']);
  const { sql: rendered, params } = query.toSQL();

  test('counts distinct accounts per installation', () => {
    expect(rendered).toContain('select "installation_id", count(distinct "account_id")');
    expect(rendered).toContain('group by "kortix"."account_github_installations"."installation_id"');
  });

  test('excludes the calling account and selects no identifying column', () => {
    expect(rendered).toContain('"account_id" <> $3');
    expect(params).toEqual(['84', '99', 'account-1']);
    // Only the installation id and a count leave this query.
    expect(rendered).not.toContain('"owner_login"');
    expect(rendered.slice(0, rendered.indexOf(' from '))).not.toContain('"owner_login"');
  });
});
