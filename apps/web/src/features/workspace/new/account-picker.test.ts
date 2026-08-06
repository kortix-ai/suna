import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'account-picker.tsx'), 'utf8');

/**
 * Source with comments stripped, same convention as `advanced-fields.test.ts`
 * / `new-workspace-page.test.ts`. This component's own doc comment legitimately
 * explains what it does NOT show ("Renders NOTHING for a user with one
 * account") — so a raw `source.not.toContain(...)` vocabulary check would risk
 * failing against the comment rather than the markup. Assertions below run
 * against `code`, what actually renders.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('AccountPicker: hidden below two accounts', () => {
  test('returns null before rendering anything when there are fewer than two accounts', () => {
    expect(code).toContain('accounts.length < 2');
    expect(code).toContain('return null');
    // Paired presence check: the guard is followed by real markup, not a
    // component that always returns null regardless of the guard.
    expect(code).toContain('<Select');
  });

  test('the length guard is the ONLY early return — nothing else can short-circuit the picker', () => {
    const returnNullMatches = code.match(/return null/g) ?? [];
    expect(returnNullMatches).toHaveLength(1);
  });
});

describe('AccountPicker: vocabulary', () => {
  test('labels the field "Account" — never "Organization" or "Team"', () => {
    // Exact label text, not just the substring "Account" appearing anywhere
    // (e.g. inside a class name or an unrelated word) — this is the actual
    // <Label> child.
    expect(code).toContain('>Account<');
    expect(code).not.toContain('Organization');
    expect(code).not.toContain('Team');
  });
});

describe('AccountPicker: EntityAvatar matches the workspace-switcher row scale', () => {
  test('sizes every account avatar "sm" — the same size workspace-switcher.tsx uses for its rows', () => {
    expect(code).toContain('<EntityAvatar');
    expect(code).toContain('size="sm"');
    // Paired negative: no other scale sneaks in for this component's avatars,
    // which would desync it from the workspace-switcher row it sits beside in
    // spirit (both surfaces list accounts/workspaces at one shared tile size).
    expect(code).not.toContain('size="xs"');
    expect(code).not.toContain('size="md"');
    expect(code).not.toContain('size="lg"');
    expect(code).not.toContain('size="xl"');
  });
});

describe('AccountPicker: renders inside the page card, not a second one', () => {
  test('never reaches for the Card primitive', () => {
    // card.tsx:35 — Card is a transparent, borderless grid system, not a
    // bordered panel. A previous task in this plan already had to fix a
    // card-inside-a-card; this component must not reintroduce it.
    expect(code).not.toContain('<Card');
    expect(code).not.toContain("from '@/components/ui/card'");
    // Paired presence: the plain field-group wrapper this file uses instead.
    expect(code).toContain('flex flex-col gap-1.5');
  });

  test('uses the shared Label component, same as the name field and Advanced disclosure', () => {
    expect(code).toContain('<Label');
    expect(code).toContain("from '@/components/ui/label'");
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

describe('AccountPicker: exports', () => {
  test('exports AccountPicker taking accounts, value and onChange', () => {
    expect(code).toContain('export function AccountPicker(');
    expect(code).toContain('accounts: KortixAccount[]');
    expect(code).toContain('value: string | null');
    expect(code).toContain('onChange: (accountId: string) => void');
  });
});
