import { describe, expect, test } from 'bun:test';

import {
  INITIAL_FORM_STATE,
  buildProvisionPayload,
  filterCreatableAccounts,
  isSubmittable,
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
    name: 'jay@kortix.ai',
    slug: 'jay',
    account_role: 'owner',
    is_primary_owner: true,
  };

  test('returns null when there are no creatable accounts', () => {
    expect(resolveDefaultCreatableAccountId([], 'jay@kortix.ai')).toBeNull();
  });

  test('prefers the account whose name matches the signed-in email (case-insensitive)', () => {
    expect(resolveDefaultCreatableAccountId([team, personal], 'Jay@Kortix.ai')).toBe(
      'a-personal',
    );
  });

  test('falls back to slug match against the email or its local-part', () => {
    const bySlug: KortixAccount = {
      account_id: 'a-slug',
      name: 'Personal',
      slug: 'jay@kortix.ai',
      account_role: 'owner',
    };
    expect(resolveDefaultCreatableAccountId([team, bySlug], 'jay@kortix.ai')).toBe('a-slug');

    const byLocal: KortixAccount = {
      account_id: 'a-local',
      name: 'Personal',
      slug: 'jay',
      account_role: 'admin',
    };
    expect(resolveDefaultCreatableAccountId([team, byLocal], 'jay@kortix.ai')).toBe('a-local');
  });

  test('falls back to is_primary_owner when nothing matches the email', () => {
    const primary: KortixAccount = {
      account_id: 'a-primary',
      name: 'Me',
      account_role: 'owner',
      is_primary_owner: true,
    };
    expect(resolveDefaultCreatableAccountId([team, primary], 'other@kortix.ai')).toBe(
      'a-primary',
    );
  });

  test('falls back to the first creatable account when nothing else matches', () => {
    expect(resolveDefaultCreatableAccountId([team, admin], null)).toBe('a-team');
  });

  test('returns the sole creatable account even with no email', () => {
    expect(resolveDefaultCreatableAccountId([personal], null)).toBe('a-personal');
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
