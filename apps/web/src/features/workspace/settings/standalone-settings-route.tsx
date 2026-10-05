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

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import type { SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { projectPathFromId } from '@/lib/onboarding/landing-destination';
import { readLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { ACCOUNT_PANEL_PARAM } from '@/stores/account-panel-store';
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
 * which redirects to the `/projects/start` chooser. Neither path creates a
 * project, so the no-app-access user this route exists for is never handed
 * one by pressing Escape.
 *
 * Pure and exported for its unit test.
 */
export function resolveSettingsExitPath(lastProjectId: string | null | undefined): string {
  return projectPathFromId(lastProjectId) ?? '/projects';
}

/**
 * The route's body, behind a Suspense boundary because it reads `?accountId=`
 * — the same read `AccountHubPanel` makes one level up, under the layout's own
 * boundary. On a route that renders statically (Vercel bakes the runtime
 * config, so these routes can) the boundary keeps the read a CSR bailout
 * into `null` instead of a build error, and the hub and the panel both come
 * back at hydration.
 */
function StandaloneSettingsBody({ tab }: { tab: SettingsTab }) {
  const router = useRouter();
  const { user } = useAuth();
  // `ProjectShell` gets its account from the project; this mount has none, so
  // without this every account-scoped tab renders empty. See the hook.
  useEnsureSelectedAccount();

  // The account hub is a full-screen modal over THIS route exactly like the
  // panel is, and it is mounted one level up in `(app)/layout.tsx` with the
  // `?accountId=` param as its open state (`stores/account-panel-store.ts`).
  // On a hard-loaded hub deep link (`/settings?accountId=<id>` — the URL the
  // hub shows in the address bar and the href of its Manage link) the hub is
  // therefore already open when this route mounts, and the z-stack hands the
  // top layer to the dialog that opened last (`lib/z-stack.tsx`): raising the
  // personal panel here buries the hub the URL names, and the deep link lands
  // on Profile. So the panel yields — it opens only when the hub is not on
  // the URL, i.e. on a plain load, or once the hub closes and drops the param.
  const hubOpen = useSearchParams().get(ACCOUNT_PANEL_PARAM) !== null;

  const open = useSettingsPanelStore((s) => s.open);
  // The store starts closed, so "closed" only means "the user closed it" after
  // we have seen it open at least once. Without this latch the mount-time
  // `false` would fire the exit navigation before the panel ever appeared.
  const wasOpened = useRef(false);

  const openedTab = useRef<SettingsTab | null>(null);
  useEffect(() => {
    if (hubOpen) return;
    // Route changes select their tab; returning from the hub preserves the
    // personal panel's selection if it is already open.
    if (openedTab.current !== tab || !useSettingsPanelStore.getState().open) {
      useSettingsPanelStore.getState().openSettings(tab);
      openedTab.current = tab;
    }
  }, [hubOpen, tab]);

  useEffect(() => {
    if (open) {
      wasOpened.current = true;
      return;
    }
    if (!wasOpened.current) return;
    router.replace(resolveSettingsExitPath(readLastProjectId(user?.id)));
  }, [open, router, user?.id]);

  return <SettingsPanel />;
}

export function StandaloneSettingsRoute({ tab }: { tab: SettingsTab }) {
  return (
    <>
      {/* Opaque, full-height, and behind the overlay's own backdrop — see this
          file's header comment on the blank page. */}
      <div className="bg-background min-h-screen" />
      <Suspense fallback={null}>
        <StandaloneSettingsBody tab={tab} />
      </Suspense>
    </>
  );
}
