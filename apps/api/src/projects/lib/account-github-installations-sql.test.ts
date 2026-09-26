/**
 * The two account-connection queries, pinned as RENDERED SQL.
 *
 * `getAccountGitHubInstallation(accountId, null)` returns the first row of the
 * list, so an unordered select makes "this account's GitHub connection" a
 * property of the heap: the same request can resolve to a different connection
 * between two calls, and a repo create can land under the wrong one.
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

  test('orders by created_at, then installation_id', () => {
    expect(rendered).toContain(
      'order by "kortix"."account_github_installations"."created_at" asc, ' +
        '"kortix"."account_github_installations"."installation_id" asc',
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
