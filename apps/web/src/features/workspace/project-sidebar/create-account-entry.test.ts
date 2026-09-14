/**
 * The product must always offer a LIVE, discoverable way to create an account.
 *
 * It stopped offering one. Every affordance still existed in the tree and none
 * of them rendered: `features/layout/account-switcher.tsx` is mounted only by
 * the dead `AppHeader`, and the hub's account-list pane renders only for
 * `hubTarget(null)`, which no live caller opens.
 *
 * So the guard cannot be "the string exists somewhere" — that was true the
 * whole time it was broken. It is pinned to surfaces that provably render:
 *
 * - the project sidebar's switcher, which `ProjectSidebar` mounts on every
 *   `/projects/[id]` route;
 * - the account hub's sidebar, which `AccountSettingsShell` mounts whenever the
 *   hub is open on an account — the view a person is in when they manage
 *   accounts.
 *
 * All of them run ONE success path, `useCreateAccountFlow`. Three hand-copied
 * `onCreated` blocks are how the landing bug below shipped on one path at a
 * time.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../../../translations/en.json';

const read = (relative: string) => readFileSync(join(import.meta.dir, relative), 'utf8');

const flow = read('../../accounts/use-create-account-flow.tsx');
const switcher = read('workspace-switcher.tsx');
const hubSidebar = read('../../accounts/hub/account-settings-sidebar.tsx');
const hubList = read('../../accounts/hub/account-list-content.tsx');

const CALLERS = [
  ['workspace-switcher.tsx', switcher, false],
  ['account-settings-sidebar.tsx', hubSidebar, true],
  ['account-list-content.tsx', hubList, true],
] as const;

describe('useCreateAccountFlow — the one success path', () => {
  test('mounts CreateAccountModal and hands its create to onCreated', () => {
    // `<CreateAccountModal`, not the bare identifier: a comment or an unused
    // import mentioning it must not satisfy this.
    expect(flow).toContain('<CreateAccountModal');
    expect(flow).toContain('onCreated={onCreated}');
    expect(flow).toContain("from '@/features/accounts/create-account-modal'");
  });

  test('the affordance is gated on the account-creation restriction', () => {
    // Self-host sets KORTIX_RESTRICT_ACCOUNT_CREATION; admins stay exempt. The
    // backend 403 is authoritative either way — this only avoids offering an
    // affordance the person cannot use.
    expect(flow).toContain(
      'const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);',
    );
  });

  test('seeds the reader key and selects the new account', () => {
    expect(flow).toContain('queryClient.setQueryData<KortixAccount[]>(accountsQueryKey');
    expect(flow).toContain('setSelectedAccountId(account.account_id);');
  });

  /**
   * Creating an account used to end on the landing door, which opens the first
   * project found in ANY account — so a brand-new empty account fell through to
   * another account's project, and `projects/start/page.tsx` then healed the
   * persisted selection to THAT account. It looked like nothing had happened.
   */
  test('lands in the NEW account on /new, never the landing door', () => {
    expect(flow).toContain('newWorkspacePathForAccount(account.account_id)');
    expect(flow).not.toContain('PROJECT_LANDING_PATH');
  });

  test('inside the hub it forgets the pushed entry, then replaces', () => {
    const forget = flow.indexOf('forgetPushedEntry();');
    const replace = flow.indexOf('router.replace(destination);');
    const push = flow.indexOf('router.push(destination);');
    expect(forget).toBeGreaterThan(flow.indexOf('if (insideHub) {'));
    expect(replace).toBeGreaterThan(forget);
    // The push path sits after the hub branch returned.
    expect(push).toBeGreaterThan(replace);
  });
});

describe('create-account callers', () => {
  for (const [name, code, insideHub] of CALLERS) {
    test(`${name} runs the shared flow with insideHub: ${insideHub}`, () => {
      expect(code).toContain("from '@/features/accounts/use-create-account-flow'");
      expect(code).toContain(`insideHub: ${insideHub},`);
      expect(code).toContain('{createAccountDialog}');
    });

    test(`${name} does not mount its own CreateAccountModal`, () => {
      expect(code).not.toContain('<CreateAccountModal');
    });
  }

  test('the switcher row opens the flow, beside the create-project row', () => {
    expect(switcher).toContain('deferAfterClose(openCreateAccount)');
    // Both live inside the switch submenu, the one view grouped BY account
    // (`workspace-menu-section.tsx`).
    const createProject = switcher.indexOf("t('workspace.create')");
    const createAccount = switcher.indexOf("t('workspace.createAccount')");
    expect(createProject).toBeGreaterThan(-1);
    expect(createAccount).toBeGreaterThan(createProject);
    expect(createAccount).toBeLessThan(switcher.indexOf('</DropdownMenuSubContent>'));
    expect(en.sidebar.workspace.createAccount).toBeTruthy();
  });

  test('the hub sidebar row sits in the Accounts menu, after the accounts', () => {
    const accountRows = hubSidebar.indexOf('{accounts.map((account) => {');
    const row = hubSidebar.indexOf('onClick={openCreateAccount}');
    const menuEnd = hubSidebar.indexOf('</SidebarMenu>', accountRows);
    expect(accountRows).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(accountRows);
    expect(row).toBeLessThan(menuEnd);
    // Gated, and labelled with the existing "New account" copy.
    expect(hubSidebar).toContain('{canCreateAccount ? (');
    expect(hubSidebar).toContain("tI18nComplete.raw('textb8773d75259e')");
    expect(en.hardcodedUi.i18nComplete.textb8773d75259e).toBe('New account');
  });
});

test('/new seeds the picked account from the url', () => {
  const page = read('../new/new-workspace-page.tsx');
  expect(page).toContain('readAccountParam');
  // Seeded into INITIAL state, like `?source=` — a later param change must
  // never fight the user's own Select.
  expect(page).toContain('...(initialAccountId ? { accountId: initialAccountId } : {})');
});
