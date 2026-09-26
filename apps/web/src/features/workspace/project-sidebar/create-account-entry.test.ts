/**
 * The product must always offer a LIVE, discoverable way to create an account.
 *
 * It stopped offering one. Every affordance still existed in the tree and none
 * of them rendered:
 *
 * - `features/layout/account-switcher.tsx` carried a "New account" row and
 *   mounted `CreateAccountModal`, but its only render site was `AppHeader`,
 *   and `AppHeader` had no render site at all — the accounts layout was
 *   replaced by `AccountSettingsShell`, which never mounts it. Both files are
 *   deleted now. Dead code cannot be an entry point.
 * - `features/accounts/hub/account-list-content.tsx` carries the other one. It
 *   renders only for `hubTarget(null)` (`?accountId=` with no value), and every
 *   live caller opens the hub ON an account, so the list pane was reachable
 *   only by opening Account settings and clicking the hub's root breadcrumb.
 *
 * So the guard cannot be "the string exists somewhere" — that was true the
 * whole time it was broken. It has to be pinned to a surface that provably
 * renders: the project sidebar's workspace switcher, which `ProjectSidebar`
 * mounts on every `/projects/[id]` route.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../../../translations/en.json';

const switcher = readFileSync(join(import.meta.dir, 'workspace-switcher.tsx'), 'utf8');

describe('create-account entry point', () => {
  test('the workspace switcher mounts CreateAccountModal', () => {
    // `<CreateAccountModal`, not the bare identifier: a comment or an unused
    // import mentioning it must not satisfy this.
    expect(switcher).toContain('<CreateAccountModal');
    expect(switcher).toContain("from '@/features/accounts/create-account-modal'");
  });

  test('it renders a row that opens the modal', () => {
    expect(switcher).toContain("t('workspace.createAccount')");
    expect(switcher).toContain('setCreateAccountOpen(true)');
  });

  test('the row is gated on the account-creation restriction, not hidden outright', () => {
    // Self-host sets KORTIX_RESTRICT_ACCOUNT_CREATION; admins stay exempt. The
    // backend 403 is authoritative either way — this only avoids offering an
    // affordance the person cannot use.
    expect(switcher).toContain('canCreateAccount');
    expect(switcher).toContain(
      'const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);',
    );
  });

  test('the row sits beside the workspace-create row, in the account-grouped menu', () => {
    // Both live inside the "Switch Workspace" submenu, which is the one view
    // already grouped BY account (`workspace-menu-section.tsx`).
    const createWorkspace = switcher.indexOf("t('workspace.create')");
    const createAccount = switcher.indexOf("t('workspace.createAccount')");
    expect(createWorkspace).toBeGreaterThan(-1);
    expect(createAccount).toBeGreaterThan(createWorkspace);
    const submenuEnd = switcher.indexOf('</DropdownMenuSubContent>');
    expect(createAccount).toBeLessThan(submenuEnd);
  });

  test('the copy is a real translation key, not a hardcoded string', () => {
    expect(en.sidebar.workspace.createAccount).toBeTruthy();
  });

  /**
   * Creating an account used to end on the landing door, which opens the first
   * project found in ANY account — so a brand-new empty account fell through to
   * another account's project, and `projects/start/page.tsx` then healed the
   * persisted selection to THAT account. The create switched you into the new
   * account and the navigation switched you straight back out, which is why it
   * looked like nothing had happened.
   */
  test('both create-account paths land in the NEW account, not the landing door', () => {
    const hub = readFileSync(
      join(import.meta.dir, '../../accounts/hub/account-list-content.tsx'),
      'utf8',
    );

    for (const [name, code] of [
      ['workspace-switcher.tsx', switcher],
      ['account-list-content.tsx', hub],
    ] as const) {
      expect({ file: name, scoped: code.includes('newWorkspacePathForAccount(account.account_id)') })
        .toEqual({ file: name, scoped: true });
      // The door is what made the create look like a no-op. It must not come
      // back on either path.
      expect({ file: name, usesDoor: code.includes('PROJECT_LANDING_PATH') }).toEqual({
        file: name,
        usesDoor: false,
      });
    }
  });

  test('/new seeds the picked account from the url', () => {
    const page = readFileSync(
      join(import.meta.dir, '../new/new-workspace-page.tsx'),
      'utf8',
    );
    expect(page).toContain('readAccountParam');
    // Seeded into INITIAL state, like `?source=` — a later param change must
    // never fight the user's own Select.
    expect(page).toContain('...(initialAccountId ? { accountId: initialAccountId } : {})');
  });
});
