/**
 * "Create a project in <account>" — the only affordance that says WHICH
 * account a new project lands in.
 *
 * Before this, the product had exactly one way to create a project: a bare
 * `<Link href="/new">` with no account on it. `/new` then resolved the target
 * itself (`resolveDefaultCreatableAccountId` → the user's PERSONAL account),
 * and for anyone with a single creatable account the picker renders nothing at
 * all — so "create a project in THIS account" was not expressible anywhere.
 * The account hub had no project affordance either, and ⌘K had no create verb.
 *
 * Three things have to hold, and each one failed at some point while building
 * this, which is why each is pinned rather than trusted:
 *
 *  1. the row exists and carries the account id (`?account=`), not a bare /new;
 *  2. it is gated on the owner/admin rule the API enforces — a plain member
 *     offered this row lands on a 403 ("Owner or admin role required");
 *  3. an account with NO projects still gets the row. `groupWorkspacesByAccount`
 *     builds groups from the projects it is given, so a zero-project account is
 *     not a group — and that is precisely the account you most want to create
 *     in. The seeding happens at the call site so that function's own contract
 *     ("drops accounts that have no workspaces", `workspace-grouping.test.ts`)
 *     stays intact.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

import en from '../../../../translations/en.json';

const source = readFileSync(join(import.meta.dir, 'workspace-menu-section.tsx'), 'utf8');

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const code = stripComments(source);

describe('create a project in a specific account', () => {
  test('the row carries the account id, not a bare /new', () => {
    expect(code).toContain('newWorkspacePathForAccount(group.accountId)');
    // A bare `/new` here would re-introduce the bug: the page would resolve the
    // target itself and silently pick the personal account.
    expect(code).not.toContain('href="/new"');
  });

  test('it is an anchor, so the click never runs a cold RSC fetch', () => {
    // Same nav-contract rule the rest of this menu follows: a menu row that
    // navigates is a prefetched <Link>, never router.push at click time.
    expect(code).toMatch(/<Link href=\{newWorkspacePathForAccount\(group\.accountId\)\} prefetch>/);
  });

  test('it renders only for accounts the user may create in', () => {
    // The API gates on ACCOUNT_ACTIONS.PROJECT_CREATE and answers a plain
    // member with 403 "Owner or admin role required", so offering the row to
    // one would be a dead end.
    expect(code).toContain('filterCreatableAccounts');
    expect(code).toContain('creatableAccountIds.has(group.accountId)');
  });

  test('an account with no projects still gets a group, so it still gets the row', () => {
    expect(code).toContain('groupsWithEmptyAccounts');
    // Seeded at the call site — `groupWorkspacesByAccount` keeps its contract.
    expect(code).toContain('groupWorkspacesByAccount');
  });

  test('a failed account is not seeded as an empty group (it has its own retry row)', () => {
    // An errored project fetch folds to [], which would otherwise make the
    // account look "empty" and render it twice.
    expect(code).toContain('failedAccounts.map(({ account }) => account.account_id)');
  });

  test('"no projects yet" counts projects, not groups', () => {
    // Seeding empty groups makes `visibleGroups` non-empty for a user who owns
    // accounts but no project at all; keying the empty state off group count
    // would silently retire it.
    expect(code).toContain('visibleGroups.every((group) => group.workspaces.length === 0)');
  });

  test('the copy is a real translation key with the account interpolated', () => {
    expect(code).toContain("t('workspace.createIn'");
    expect(en.sidebar.workspace.createIn).toContain('{account}');
  });
});
