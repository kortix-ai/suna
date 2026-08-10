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
});
