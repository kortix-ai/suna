'use client';

/**
 * The project-less mount of `SettingsPanel`, behind `/settings` and
 * `/settings/[tab]`.
 *
 * **One settings surface, two mounts.** This renders the SAME `SettingsPanel`
 * `ProjectShell` renders (`project-layout/project-shell.tsx`), with no
 * `projectId`. It is not a second settings UI and must never grow one: every
 * account-scoped surface (billing, members, identity, audit, …) lives in the
 * panel, and this file exists only so the panel has a URL that does not
 * require a project.
 *
 * **Why it stopped bouncing.** This route used to set store state and
 * `router.replace(PROJECT_LANDING_PATH)` — landing on `/projects/start`, which
 * mounts the panel via `ProjectShell`. That works, but `/projects/start` is
 * the door that PROVISIONS a first project when the account has none. The one
 * caller that most needs an account-scoped settings URL is the sign-in
 * redirect for a user with NO app access
 * (`app/(auth)/auth/callback/route.ts`, `app/(auth)/auth/actions.ts`), and
 * that branch exists precisely so such a user is sent to billing INSTEAD of
 * being given a project. Bouncing through the provisioning door would have
 * inverted its whole purpose, so the panel is mounted here directly.
 *
 * **The blank page that bounce was avoiding, and how this avoids it.**
 * Rendering only `<SettingsPanel />` left a blank white page the moment the
 * user closed the overlay: the panel renders nothing when closed and nothing
 * sat behind it. Two things fix that here. The overlay closing is treated as
 * "leave settings" and navigates (see `resolveSettingsExitPath`), and what
 * renders underneath is an opaque background rather than nothing, so the
 * frames between the close and the new route painting are never white.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/features/providers/auth-provider';
import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import type { SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { readLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { projectPathFromId } from '@/lib/onboarding/landing-destination';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/**
 * The tab `/settings` (no segment) opens on.
 *
 * NOT `DEFAULT_SETTINGS_TAB` (`general`), which is the project workspace tab —
 * this route has no project, so `general` is filtered out of the rail
 * entirely (`ACCOUNT_SCOPED_SETTINGS_TABS` in `settings-panel.tsx`) and the
 * panel would immediately fall back anyway. Naming the account-scoped default
 * outright is what makes the first paint land on the right row instead of
 * flashing through a rejected one.
 */
export const STANDALONE_DEFAULT_SETTINGS_TAB: SettingsTab = 'profile';

/**
 * Where closing the overlay goes.
 *
 * The remembered project when the browser has one — the user goes back to
 * exactly where they were, and nothing is created. Otherwise `/projects`,
 * NOT `PROJECT_LANDING_PATH`.
 *
 * That fallback is deliberate and is the one place this file departs from
 * `latestProjectPath()`'s "never send an implicit destination to the list"
 * rule (`lib/onboarding/last-project-cookie.ts`). `/projects/start` creates a
 * project unconditionally (`ensureFirstProject`, gated only on the account
 * role and `navigationMayCreateProject()`), while the list applies the
 * entitlement-aware rule — `shouldAutoCreateFirstProject` returns `false`
 * when billing is on and `credits.can_run` is false, and otherwise creates
 * the project and `router.replace`s straight into it
 * (`app/(app)/projects/page.tsx:245,295`). So an entitled user still lands in
 * a project either way, and the no-app-access user this route exists for does
 * not get one handed to them by pressing Escape.
 *
 * Pure and exported for its unit test.
 */
export function resolveSettingsExitPath(lastProjectId: string | null | undefined): string {
  return projectPathFromId(lastProjectId) ?? '/projects';
}

export function StandaloneSettingsRoute({ tab }: { tab: SettingsTab }) {
  const router = useRouter();
  const { user } = useAuth();
  // `ProjectShell` gets its account from the project; this mount has none, so
  // without this every account-scoped tab renders empty. See the hook.
  useEnsureSelectedAccount();

  const open = useSettingsPanelStore((s) => s.open);
  // The store starts closed, so "closed" only means "the user closed it" after
  // we have seen it open at least once. Without this latch the mount-time
  // `false` would fire the exit navigation before the panel ever appeared.
  const wasOpened = useRef(false);

  useEffect(() => {
    useSettingsPanelStore.getState().openSettings(tab);
  }, [tab]);

  useEffect(() => {
    if (open) {
      wasOpened.current = true;
      return;
    }
    if (!wasOpened.current) return;
    router.replace(resolveSettingsExitPath(readLastProjectId(user?.id)));
  }, [open, router, user?.id]);

  return (
    <>
      {/* Opaque, full-height, and behind the overlay's own backdrop — see this
          file's header comment on the blank page. */}
      <div className="bg-background min-h-screen" />
      <SettingsPanel />
    </>
  );
}
