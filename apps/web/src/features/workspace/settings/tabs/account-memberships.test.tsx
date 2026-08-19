import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  type AccountMembership,
  AccountMembershipsSection,
  accountRoleLabel,
} from './account-memberships';

/** Row labels in document order — a `SettingsRow` label is a `FieldTitle`
 *  (`<div data-slot="field-label">`), not a heading. Same reader
 *  `connected-tab.test.tsx` uses. */
const ROW_LABEL = /<div[^>]*data-slot="field-label"[^>]*>([^<]*)<\/div>/g;
const rowLabels = (html: string): string[] => [...html.matchAll(ROW_LABEL)].map((m) => m[1]);

/** Every `href` the section emits, in order. */
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

const account = (over: Partial<AccountMembership> = {}): AccountMembership => ({
  account_id: 'acc_1',
  name: 'Acme',
  account_role: 'owner',
  ...over,
});

describe('AccountMembershipsSection', () => {
  test('renders one row per account, each linking to that account settings page', () => {
    const out = renderToStaticMarkup(
      <AccountMembershipsSection
        accounts={[
          account({ account_id: 'acc_1', name: 'Acme' }),
          account({ account_id: 'acc_2', name: 'Globex', account_role: 'member' }),
        ]}
      />,
    );
    expect(rowLabels(out)).toEqual(['Acme', 'Globex']);
    expect(hrefs(out)).toEqual(['/accounts/acc_1', '/accounts/acc_2']);
  });

  /**
   * No `?tab=`. `app/(app)/accounts/[id]/page.tsx` falls back to `members`
   * when the param is absent or unknown (`VALID_TABS`, line 349), which is the
   * section a reader arriving from "which organizations am I in" is asking
   * about — and it is the same bare target the workspace switcher's "Account
   * settings" row and the Members pane's "Organization account settings" row
   * already use. One account link in the product, one destination.
   */
  test('links to the account page default section, with no tab query', () => {
    const out = renderToStaticMarkup(<AccountMembershipsSection accounts={[account()]} />);
    expect(out).toContain('href="/accounts/acc_1"');
    expect(out).not.toContain('?tab=');
  });

  test('names the section and states what lives behind the link', () => {
    const out = renderToStaticMarkup(<AccountMembershipsSection accounts={[account()]} />);
    expect(out).toMatch(/<h3[^>]*>Organizations<\/h3>/);
    expect(out).toMatch(/Members, billing, roles, and audit/);
  });

  test('every row carries the caller role for that account', () => {
    const out = renderToStaticMarkup(
      <AccountMembershipsSection
        accounts={[
          account({ account_id: 'a', name: 'Owned', account_role: 'owner' }),
          account({ account_id: 'b', name: 'Joined', account_role: 'member' }),
        ]}
      />,
    );
    expect(out).toContain('Owner');
    expect(out).toContain('Member');
  });

  /**
   * A single account is a single row — the same shape, not a special case.
   * The pane a user in one organization sees is one line and one button, which
   * is the whole reason this is not a fourth rail row.
   */
  test('one account renders one row, in the same grouped shape', () => {
    const out = renderToStaticMarkup(<AccountMembershipsSection accounts={[account()]} />);
    expect(rowLabels(out)).toEqual(['Acme']);
    expect(out).toContain('data-slot="settings-row-group"');
  });

  test('an unnamed account still renders a label', () => {
    const out = renderToStaticMarkup(
      <AccountMembershipsSection accounts={[account({ name: '   ' })]} />,
    );
    expect(rowLabels(out)).toEqual(['Account']);
  });

  /**
   * `GET /accounts` bootstraps a personal account when the membership query
   * comes back empty (`api/src/accounts/core/accounts.ts:112`), so a signed-in
   * user never legitimately has zero. An empty array therefore means "not
   * answered yet", and the section renders nothing rather than a heading over
   * an empty box — no empty-state chrome on a two-line utility list.
   */
  test('renders nothing at all when the list is empty', () => {
    expect(renderToStaticMarkup(<AccountMembershipsSection accounts={[]} />)).toBe('');
    expect(renderToStaticMarkup(<AccountMembershipsSection />)).toBe('');
  });

  test('while loading it holds the section open with one shape-matched skeleton row', () => {
    const out = renderToStaticMarkup(<AccountMembershipsSection isLoading accounts={[]} />);
    expect(out).toMatch(/<h3[^>]*>Organizations<\/h3>/);
    expect(out).toContain('animate-pulse');
    // No row and no link may be claimed before the list answers.
    expect(rowLabels(out)).toEqual([]);
    expect(hrefs(out)).toEqual([]);
  });
});

describe('accountRoleLabel', () => {
  test('labels the three roles the API sends', () => {
    expect(accountRoleLabel('owner')).toBe('Owner');
    expect(accountRoleLabel('admin')).toBe('Admin');
    expect(accountRoleLabel('member')).toBe('Member');
  });

  /** Never echoes an unrecognized value into the UI — the row renders with no
   *  description instead. */
  test('returns undefined for anything else', () => {
    expect(accountRoleLabel(undefined)).toBeUndefined();
    expect(accountRoleLabel(null)).toBeUndefined();
    expect(accountRoleLabel('superuser')).toBeUndefined();
  });
});
