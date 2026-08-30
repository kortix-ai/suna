import { describe, expect, test } from 'bun:test';

import {
  INITIAL_FORM_STATE,
  buildProvisionPayload,
  filterCreatableAccounts,
  isForeignAccountList,
  isSubmittable,
  resolveAccountsForPicker,
  resolveDefaultCreatableAccountId,
} from './new-workspace-form';
import type { KortixAccount } from '@kortix/sdk';

const owner: KortixAccount = { account_id: 'a1', name: 'Owner Co', account_role: 'owner' };
const admin: KortixAccount = { account_id: 'a2', name: 'Admin Co', account_role: 'admin' };
const member: KortixAccount = { account_id: 'a3', name: 'Member Co', account_role: 'member' };
// `account_role` is optional on `KortixAccount` — this account has none at all.
const roleless: KortixAccount = { account_id: 'a4', name: 'No Role Co' };

describe('INITIAL_FORM_STATE', () => {
  test('defaults to a Kortix-managed repo on main, with no icon', () => {
    expect(INITIAL_FORM_STATE).toEqual({
      name: '',
      icon: null,
      source: 'managed',
      defaultBranch: 'main',
      templateId: null,
      accountId: null,
      // The two GitHub sources need an installation, and `github-import`
      // additionally a repository. Null on a `managed` default, where neither
      // is read — but present in the shape, so `isSubmittable`'s
      // `githubSourceReady` gate reads a defined field rather than
      // `undefined`.
      installationId: null,
      repoFullName: null,
    });
  });
});

describe('filterCreatableAccounts', () => {
  test('keeps owner and admin accounts', () => {
    expect(filterCreatableAccounts([owner, admin])).toEqual([owner, admin]);
  });

  test('excludes a member-role account', () => {
    // The regression this whole fix round exists for: POST /provision 403s
    // "Owner or admin role required" for a member, so offering it in the
    // picker is a choice that can only fail.
    expect(filterCreatableAccounts([owner, member])).toEqual([owner]);
  });

  test('excludes an account with no account_role at all — fails closed', () => {
    expect(filterCreatableAccounts([owner, roleless])).toEqual([owner]);
  });

  test('returns empty when nothing is creatable', () => {
    expect(filterCreatableAccounts([member, roleless])).toEqual([]);
  });

  test('one owner + one member account leaves exactly one creatable — AccountPicker (accounts.length < 2) renders nothing', () => {
    expect(filterCreatableAccounts([owner, member])).toHaveLength(1);
  });

  test('keeps the possessive suffix — never returns the bare email', () => {
    // Regression guard: this used to `.replaceAll("'s Account", '')`, which
    // turned the API's stored `"a@x.com's Account"` into a bare `a@x.com` —
    // indistinguishable from `user.email` once it reached `AccountPicker`.
    // The possessive is the only thing marking this as an account name
    // belonging to someone else, so it must survive this function untouched.
    const personalAccount: KortixAccount = {
      account_id: 'a5',
      name: "a@x.com's Account",
      account_role: 'owner',
    };
    const [result] = filterCreatableAccounts([personalAccount]);
    expect(result?.name).toContain("'s Account");
    expect(result?.name).not.toBe('a@x.com');
    expect(result?.name).toBe("a@x.com's Account");
  });
});

describe('resolveDefaultCreatableAccountId', () => {
  const team: KortixAccount = {
    account_id: 'a-team',
    name: 'Acme',
    account_role: 'owner',
  };
  const personal: KortixAccount = {
    account_id: 'a-personal',
    // REAL post-`filterCreatableAccounts` shape as of Task 1: the API always
    // stores a personal account as `"<email>'s Account"`
    // (`defaultAccountName`, apps/api/src/accounts/core/app.ts). Personal
    // accounts use `accountId === userId` by construction
    // (`bootstrap-personal-account.ts`), so `'a-personal'` doubles as both
    // this account's id and the signed-in user's id in the tests below.
    name: "jay@kortix.ai's Account",
    account_role: 'owner',
    is_primary_owner: true,
  };

  // Task 2 replaced the `byName`/`bySlug` email-matching tiers entirely —
  // both were permanently dead against the real `GET /v1/accounts` shape
  // (see `resolveDefaultCreatableAccountId`'s doc comment in
  // `new-workspace-form.ts`). There is no successor test for "matches by
  // name" or "matches by slug": that behavior no longer exists, on purpose.
  // The identity tier below (`account_id === userId`) is what replaces it.

  test('returns null when there are no creatable accounts', () => {
    expect(resolveDefaultCreatableAccountId([], 'a-personal')).toBeNull();
  });

  test('prefers the account whose account_id equals the signed-in user id, regardless of list order', () => {
    expect(resolveDefaultCreatableAccountId([team, personal], 'a-personal')).toBe('a-personal');
    expect(resolveDefaultCreatableAccountId([personal, team], 'a-personal')).toBe('a-personal');
  });

  test('falls back to is_primary_owner when identity does not match any account', () => {
    const primary: KortixAccount = {
      account_id: 'a-primary',
      name: 'Me',
      account_role: 'owner',
      is_primary_owner: true,
    };
    expect(resolveDefaultCreatableAccountId([team, primary], 'someone-elses-id')).toBe(
      'a-primary',
    );
  });

  test('falls back to the first creatable account when nothing else matches', () => {
    expect(resolveDefaultCreatableAccountId([team, admin], null)).toBe('a-team');
  });

  test('returns the sole creatable account even with no userId', () => {
    expect(resolveDefaultCreatableAccountId([personal], null)).toBe('a-personal');
  });
});

describe('resolveDefaultCreatableAccountId: order-independent default when a user owns both a personal and a team account', () => {
  // Converts Task 1's `test.todo` (ruling R5 / Task 2 controller addendum
  // A2.1). `is_primary_owner` is `accountRole === 'owner'`
  // (apps/api/src/accounts/core/accounts.ts:126) — true for BOTH the user's
  // bootstrapped personal account and any team account they own outright, so
  // it cannot break the tie between the two. Only `account_id === userId`
  // can: it is true for the personal account by construction
  // (`bootstrap-personal-account.ts`) and never true for a team account,
  // which always gets its own freshly generated account id. Run through the
  // REAL composed pipeline (`filterCreatableAccounts` then
  // `resolveDefaultCreatableAccountId`), exactly as `/new` calls them.
  test('personal account wins regardless of list order', () => {
    const userId = 'a-personal-order';
    const personalAccount: KortixAccount = {
      account_id: 'a-personal-order',
      name: "jay@kortix.ai's Account",
      account_role: 'owner',
      is_primary_owner: true,
    };
    // A team the SAME user also owns outright — not their personal account,
    // but `is_primary_owner` cannot tell the two apart.
    const teamAccountUserOwns: KortixAccount = {
      account_id: 'a-team-order',
      name: 'Acme Inc',
      account_role: 'owner',
      is_primary_owner: true,
    };

    const personalFirst = filterCreatableAccounts([personalAccount, teamAccountUserOwns]);
    const teamFirst = filterCreatableAccounts([teamAccountUserOwns, personalAccount]);

    expect(resolveDefaultCreatableAccountId(personalFirst, userId)).toBe('a-personal-order');
    expect(resolveDefaultCreatableAccountId(teamFirst, userId)).toBe('a-personal-order');
  });
});

describe('isForeignAccountList', () => {
  const own: KortixAccount = { account_id: 'me', name: "me@x.com's Account", account_role: 'owner' };
  const foreign1: KortixAccount = { account_id: 'org-1', name: 'Acme Inc', account_role: 'admin' };
  const foreign2: KortixAccount = { account_id: 'org-2', name: 'Widgets Co', account_role: 'admin' };

  test('false for zero creatable accounts', () => {
    expect(isForeignAccountList([], 'me')).toBe(false);
  });

  test("false for a SOLE account that is not the viewer's own — the ordinary invited-admin case, not FOREIGN", () => {
    expect(isForeignAccountList([foreign1], 'me')).toBe(false);
  });

  test("false for two or more accounts once at least one is the viewer's own, regardless of order", () => {
    expect(isForeignAccountList([own, foreign1], 'me')).toBe(false);
    expect(isForeignAccountList([foreign1, own], 'me')).toBe(false);
  });

  test("true for two or more accounts, none of them the viewer's own", () => {
    expect(isForeignAccountList([foreign1, foreign2], 'me')).toBe(true);
  });

  test('true for two or more accounts when the viewer id is not known at all', () => {
    expect(isForeignAccountList([foreign1, foreign2], null)).toBe(true);
    expect(isForeignAccountList([foreign1, foreign2], undefined)).toBe(true);
  });
});

describe('resolveAccountsForPicker', () => {
  const ownSole: KortixAccount = { account_id: 'me', name: "me@x.com's Account", account_role: 'owner' };
  const foreignSole: KortixAccount = { account_id: 'org-1', name: 'Acme Inc', account_role: 'admin' };
  const foreignSecond: KortixAccount = { account_id: 'org-2', name: 'Widgets Co', account_role: 'admin' };

  test('sole OWN account: suppressed to an empty array — AccountPicker renders the identity line alone (A2.2)', () => {
    expect(resolveAccountsForPicker([ownSole], 'me')).toEqual([]);
  });

  test('sole FOREIGN account: NOT suppressed — the invited-admin scenario must still name the account (A2.2, do not re-open Task 1s disclosure fix)', () => {
    expect(resolveAccountsForPicker([foreignSole], 'me')).toEqual([foreignSole]);
  });

  test('a FOREIGN list (two or more, none owned): suppressed to an empty array — no account name renders at all', () => {
    expect(resolveAccountsForPicker([foreignSole, foreignSecond], 'me')).toEqual([]);
  });

  test("a normal multi-account list that includes the viewer's own: passed through unmodified", () => {
    expect(resolveAccountsForPicker([ownSole, foreignSole], 'me')).toEqual([ownSole, foreignSole]);
  });

  test('zero accounts: passed through as empty, trivially', () => {
    expect(resolveAccountsForPicker([], 'me')).toEqual([]);
  });
});

describe('isSubmittable', () => {
  test('false while the name is empty', () => {
    expect(isSubmittable(INITIAL_FORM_STATE, 1)).toBe(false);
  });

  test('true with a valid name and a single account', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web' }, 1)).toBe(true);
  });

  test('false with a valid name, several accounts, and none chosen', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web' }, 3)).toBe(false);
  });

  test('true once an account is chosen', () => {
    expect(
      isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'a1' }, 3),
    ).toBe(true);
  });

  test('false when the name breaks the charset rule', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'my/agi' }, 1)).toBe(false);
  });

  test('false at zero accounts — the query has not resolved, or there is nowhere to create', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web' }, 0)).toBe(false);
  });

  test('false at zero accounts even when an account id is somehow set', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web', accountId: 'a1' }, 0)).toBe(false);
  });
});

describe('buildProvisionPayload', () => {
  test('sends the trimmed name and seeds the starter', () => {
    const payload = buildProvisionPayload({ ...INITIAL_FORM_STATE, name: '  suna-web  ' });
    expect(payload.name).toBe('suna-web');
    expect(payload.seed_starter).toBe(true);
  });

  test('omits icon keys entirely when no icon is picked', () => {
    const payload = buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' });
    expect('icon' in payload).toBe(false);
    expect('icon_glyph' in payload).toBe(false);
  });

  test('sends icon for an emoji and never both icon keys', () => {
    const payload = buildProvisionPayload({
      ...INITIAL_FORM_STATE,
      name: 'x',
      icon: { emoji: '\u{1F680}' },
    });
    expect(payload.icon).toBe('\u{1F680}');
    expect('icon_glyph' in payload).toBe(false);
  });

  test('sends icon_glyph for a glyph and never both icon keys', () => {
    const payload = buildProvisionPayload({
      ...INITIAL_FORM_STATE,
      name: 'x',
      icon: { glyph: { name: 'Rocket', color: 'green' } },
    });
    expect(payload.icon_glyph).toEqual({ name: 'Rocket', color: 'green' });
    expect('icon' in payload).toBe(false);
  });

  test('sends source_item_id only when a template is chosen', () => {
    expect('source_item_id' in buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' })).toBe(
      false,
    );
    expect(
      buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x', templateId: 'item-1' })
        .source_item_id,
    ).toBe('item-1');
  });

  test('sends account_id only when one is chosen', () => {
    expect('account_id' in buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' })).toBe(false);
    expect(
      buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x', accountId: 'a1' }).account_id,
    ).toBe('a1');
  });
});
