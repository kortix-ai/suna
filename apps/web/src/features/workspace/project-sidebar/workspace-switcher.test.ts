import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `WorkspaceSwitcher` cannot be rendered here — `apps/web`'s `bun test` has no
 * DOM harness, and its whole body is a Radix `DropdownMenu` that renders
 * through a portal (see `user-menu.test.tsx` for the same constraint). These
 * scan the source instead, the way every sibling source-contract test does.
 *
 * What they pin is exactly what the `main` merge could have silently dropped:
 * this control REPLACED the project sidebar's `UserMenu` footer, and two
 * behaviours only existed because that menu was mounted there.
 */
const source = readFileSync(join(import.meta.dir, 'workspace-switcher.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('WorkspaceSwitcher keeps what the sidebar UserMenu used to provide', () => {
  test('seeds selectedAccountId, so account-scoped settings tabs can resolve an account', () => {
    // `use-ensure-selected-account.ts`'s own header names `ProjectSidebar`
    // rendering `UserMenu` as the mount that made it run. That footer menu is
    // gone; this control is its replacement, so the call lives here now.
    // Without it a brand-new sign-in has `selectedAccountId === null`, and
    // Billing / Usage / Identity / Audit / API keys / Organization render
    // EMPTY — indistinguishable from "you lack permission".
    expect(code).toContain('useEnsureSelectedAccount()');
    expect(code).toContain(
      "import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account'",
    );
  });

  test('User Settings opens the settings panel, not the deleted modal', () => {
    // `main` authored this row against `SidePanelUserSettings`, which this
    // branch deleted (JAY-498). It opens the same panel `UserMenu` opens.
    expect(code).toContain('useSettingsPanelStore.getState().openSettings(tab)');
    expect(code).not.toContain('SidePanelUserSettings');
  });

  /**
   * The TAB the row passes, which the test above does not pin.
   *
   * `ProjectSidebar` mounts this control on every project route, and
   * `ProjectShell` renders `SettingsPanel` as a sibling
   * (`project-layout/project-shell.tsx:195`) — so unlike the header
   * `UserMenu`, this row's store write really does open the overlay. That
   * makes a wrong tab a live bug, not a no-op: `general` is Workspace →
   * General in `settings/settings-tabs.ts`, a PROJECT-scoped tab, so a row
   * labelled "User Settings" would land the user on the workspace pane
   * instead of their own profile.
   *
   * `code` has comments stripped (see above), so prose naming `general` — and
   * this file's own explanation of why it is wrong — cannot satisfy or defeat
   * the match. Both directions are asserted: the right tab present AND the
   * wrong one absent.
   */
  test('User Settings is wired to `profile`, not the project-scoped `general`', () => {
    const calls = [...code.matchAll(/openUserSettings\('([^']+)'\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toContain('profile');
    expect(calls).not.toContain('general');
  });
});
