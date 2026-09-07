// The Access → Help pane replaces the old `PermissionsHelpPopover`, whose
// "Custom roles" section was dead code: the component gated it on an
// `accountId` prop that its only mount never passed, so the one place that
// explained custom roles was unreachable in the running app. These pins keep
// every section present, linkable, and sourced from the shared role
// descriptors instead of a second copy of the copy.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'access-help.tsx'), 'utf8');
const flat = source.replace(/\s+/g, ' ');

describe('access help page', () => {
  test('renders every section of the unified model', () => {
    for (const key of [
      'text1ba70b3e6cfc',
      'text49c8061192c7',
      'text31b7c5d19327',
      'textc703c7f9cbe6',
      'text29f30b14dfba',
    ]) {
      expect(flat).toContain(`raw('${key}')`);
    }
    expect(flat).toContain("raw('text39bbb719fa2b')");
    expect(flat).toContain("raw('text279b44d2ab4b')");
  });

  test('role copy comes from the shared descriptors, not a local copy', () => {
    expect(source).toContain("from '@/features/workspace/shared/access'");
    expect(source).toContain('ACCOUNT_ROLE_DESCRIPTORS');
    expect(source).toContain('PROJECT_ROLE_DESCRIPTORS');
    // `.summary` is the two-sentence variant written for exactly this page;
    // `.blurb` is the one-liner the select items use.
    expect(source).toContain('.summary');
  });

  // Owner decision 2026-08-18: Member and Manager are the only project roles.
  // The list is driven by `PROJECT_ROLES_ASCENDING`, so it cannot drift from
  // the select — but no Editor copy may survive anywhere on the page.
  test('no Editor role is described anywhere', () => {
    expect(flat).not.toContain('Editor');
  });

  // The paragraph that keeps the two authority systems apart. Without it people
  // read "role" as covering what a running agent may do, which it does not —
  // that is the manifest's Kortix CLI scopes. Same wording as
  // `content/docs/accounts.mdx`'s "one vocabulary, two bindings".
  test('it states the one-vocabulary-two-bindings rule', () => {
    expect(flat).toContain("raw('textec56dc3a282b')");
    expect(flat).toContain("raw('textfe384b93382f')");
  });

  // Every noun the model uses appears, once, on the page that teaches it.
  test('it names the four nouns of the model', () => {
    for (const key of [
      'textafc19f1734c1',
      'text14736a2eb9f4',
      'textb073f6c68ef8',
      'text153cdaaec561',
    ]) {
      expect(flat).toContain(`raw('${key}')`);
    }
  });

  test('the custom-roles section links to the Roles tab with a real accountId', () => {
    expect(flat).toContain('href={`/accounts/${accountId}?tab=roles`}');
  });

  test('it is a page, not a popover', () => {
    // The old surface was a `Popover` in the rail footer; nothing here may
    // render one (the header comment naming the retired component is fine).
    expect(source).not.toContain('<Popover');
    expect(source).not.toContain("from '@/components/ui/popover'");
  });
});
