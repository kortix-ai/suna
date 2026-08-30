import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveAccountPickerIdentity } from './account-picker';
import type { KortixAccount } from '@kortix/sdk';

const source = readFileSync(join(import.meta.dir, 'account-picker.tsx'), 'utf8');

/**
 * Source with comments stripped, same convention as `advanced-fields.test.ts`
 * / `new-workspace-page.test.ts`. This component's own doc comment legitimately
 * explains what it does NOT show — so a raw `source.not.toContain(...)`
 * vocabulary check would risk failing against the comment rather than the
 * markup. Assertions below run against `code`, what actually renders.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('AccountPicker: collapses below two accounts', () => {
  test('renders static muted identity text when there are fewer than two accounts', () => {
    expect(code).toContain('accounts.length < 2');
    expect(code).toContain('text-muted-foreground min-w-0 truncate text-sm');
    // Still gates the Select — a one-option select is not a decision.
    expect(code).toContain('<Select');
    const selectAt = code.indexOf('<Select');
    const guardAt = code.indexOf('accounts.length < 2');
    expect(guardAt).toBeGreaterThan(0);
    expect(selectAt).toBeGreaterThan(guardAt);
  });

  test('returns null only when there is nothing to show at all', () => {
    // One early return: both the identity line and the account line are
    // empty. The <2 branch itself does not always null out — it paints
    // fallbackLabel and/or the sole account's name as two separate lines.
    const returnNullMatches = code.match(/return null/g) ?? [];
    expect(returnNullMatches).toHaveLength(1);
    expect(code).toContain('if (!identityLabel && !accountLabel) return null');
  });

  test('identity and account render as two separate elements, never concatenated into one string', () => {
    // Regression guard for the disclosure this split exists to close: an
    // account name (which can belong to someone else) must never be
    // interpolated into the same string as the identity label.
    expect(code).not.toMatch(/identityLabel\s*\+/);
    expect(code).not.toMatch(/\$\{identityLabel\}.*\$\{accountLabel\}/);
    expect(code).toContain('Create in');
    // Two independently-conditioned spans, not one branch painting either
    // value into a shared slot.
    expect(code).toContain('{identityLabel ? (');
    expect(code).toContain('{accountLabel ? (');
  });
});

describe('AccountPicker: quiet header trigger, not a form field', () => {
  test('has no Label and no field-group card wrapper', () => {
    expect(code).not.toContain('<Label');
    expect(code).not.toContain("from '@/components/ui/label'");
    expect(code).not.toContain('flex flex-col space-y-3');
    expect(code).not.toContain('<Card');
    expect(code).not.toContain("from '@/components/ui/card'");
  });

  test('exposes "Account" as the trigger aria-label — never Organization or Team', () => {
    expect(code).toContain('aria-label="Account"');
    expect(code).not.toContain('Organization');
    expect(code).not.toContain('Team');
  });

  test('uses the transparent SelectTrigger so it reads as a span click, not a boxed field', () => {
    expect(code).toContain('variant="transparent"');
    expect(code).toContain('text-muted-foreground hover:text-foreground');
  });
});

describe('AccountPicker: EntityAvatar matches AccountSwitcher header scale', () => {
  test('sizes every account avatar "xs" — same tile as account-switcher.tsx', () => {
    expect(code).toContain('<EntityAvatar');
    const avatars = code.match(/<EntityAvatar[\s\S]*?\/>/g) ?? [];
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) expect(avatar).toContain('size="xs"');
    // NOT a blanket ban on `size="sm"`: the SelectTrigger carries one, and that
    // is a control height, not a tile scale.
    expect(code).not.toContain('size="lg"');
    expect(code).not.toContain('size="xl"');
  });
});

describe('AccountPicker: every account is selectable and reported verbatim', () => {
  test('maps every account into a SelectItem keyed by account_id', () => {
    expect(code).toContain('accounts.map(');
    expect(code).toContain('<SelectItem');
    expect(code).toContain('account.account_id');
  });

  test('passes the raw account id straight through to onChange — no wrapping, no derived object', () => {
    expect(code).toContain('onValueChange={onChange}');
  });
});

describe('resolveAccountPickerIdentity: the identity slot never carries an account name', () => {
  // The exact shape of the disclosure this fix closes: an invited admin's
  // only creatable account is the OWNER's personal account, stored by
  // `bootstrap-personal-account.ts` as `"<owner-email>'s Account"`.
  const ownersPersonalAccount: KortixAccount = {
    account_id: 'a1',
    name: "owner@x.com's Account",
    account_role: 'admin',
  };

  test('accounts.length < 2 with a non-null fallbackLabel: identityLabel is fallbackLabel, never accounts[0].name', () => {
    const result = resolveAccountPickerIdentity({
      accounts: [ownersPersonalAccount],
      value: null,
      fallbackLabel: 'admin@invited.com',
    });
    expect(result.identityLabel).toBe('admin@invited.com');
    expect(result.identityLabel).not.toBe(ownersPersonalAccount.name);
    // The account name is still surfaced — as the SEPARATE "Create in" value.
    expect(result.accountLabel).toBe(ownersPersonalAccount.name);
  });

  test('a selected value does not change which field the identity comes from', () => {
    const result = resolveAccountPickerIdentity({
      accounts: [ownersPersonalAccount],
      value: 'a1',
      fallbackLabel: 'admin@invited.com',
    });
    expect(result.identityLabel).toBe('admin@invited.com');
    expect(result.identityLabel).not.toBe(ownersPersonalAccount.name);
  });

  test('zero accounts: identityLabel still resolves from fallbackLabel; accountLabel is null', () => {
    expect(
      resolveAccountPickerIdentity({ accounts: [], value: null, fallbackLabel: 'me@x.com' }),
    ).toEqual({ identityLabel: 'me@x.com', accountLabel: null });
  });

  test('no fallbackLabel and no accounts: both fields are null', () => {
    expect(
      resolveAccountPickerIdentity({ accounts: [], value: null, fallbackLabel: null }),
    ).toEqual({ identityLabel: null, accountLabel: null });
  });
});

describe('AccountPicker: exports', () => {
  test('exports AccountPicker taking accounts, value, onChange and optional fallbackLabel', () => {
    expect(code).toContain('export function AccountPicker(');
    expect(code).toContain('accounts: KortixAccount[]');
    expect(code).toContain('value: string | null');
    expect(code).toContain('onChange: (accountId: string) => void');
    expect(code).toContain('fallbackLabel?: string | null');
  });
});
