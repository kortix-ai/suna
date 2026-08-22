// The Access → Help pane replaces the old `PermissionsHelpPopover`, whose
// "Custom roles" section was dead code: the component gated it on an
// `accountId` prop that its only mount never passed, so the one place that
// explained custom roles was unreachable in the running app. These pins keep
// every section present, linkable, and sourced from the shared role
// descriptors instead of a second copy of the copy.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'access-help.tsx'), 'utf8');
const flat = source.replace(/\s+/g, ' ');

describe('access help page', () => {
  test('renders every section of the unified model', () => {
    for (const title of [
      'The model',
      'Account roles',
      'Project roles',
      'Custom roles',
      'Groups',
      'Agents',
      'Override rule',
    ]) {
      expect(flat).toContain(`title="${title}"`);
    }
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
    expect(flat).toContain('One vocabulary, two bindings.');
    expect(flat).toContain(
      'People, groups and agents get roles on an account, a project, or a single resource.',
    );
    expect(flat).toContain('Agents additionally carry Kortix CLI scopes in');
    expect(flat).toContain('a session can only do what both allow.');
  });

  // Every noun the model uses appears, once, on the page that teaches it.
  test('it names the four nouns of the model', () => {
    for (const noun of ['Principal', 'Role', 'Scope', 'Assignment']) {
      expect(flat).toContain(`>${noun}</p>`);
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
