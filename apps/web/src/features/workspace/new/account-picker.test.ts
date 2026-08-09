import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  test('returns null only when there is nothing to show as identity', () => {
    // One early return: label missing. The <2 branch itself does not always
    // null out — it paints fallbackLabel / the sole account name.
    const returnNullMatches = code.match(/return null/g) ?? [];
    expect(returnNullMatches).toHaveLength(1);
    expect(code).toContain('if (!label) return null');
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

describe('AccountPicker: exports', () => {
  test('exports AccountPicker taking accounts, value, onChange and optional fallbackLabel', () => {
    expect(code).toContain('export function AccountPicker(');
    expect(code).toContain('accounts: KortixAccount[]');
    expect(code).toContain('value: string | null');
    expect(code).toContain('onChange: (accountId: string) => void');
    expect(code).toContain('fallbackLabel?: string | null');
  });
});
