'use client';

/**
 * /settings/[tab] — deep-link entry into the merged Settings overlay with NO
 * project context (e.g. `/settings/profile`, `/settings/billing`). This is
 * the account-scoped door into the same overlay the two `/projects/[id]/
 * settings*` routes open project-scoped — see the "You group" tabs
 * (profile, preferences, connected, billing, usage, ...) in `settings-tabs.ts`,
 * which is why this route exists with no `[id]` segment at all rather than
 * defaulting to some remembered project.
 *
 * This page used to render `SettingsPanel` directly (with no `projectId`),
 * because nothing else mounted the panel yet. `ProjectShell` now mounts
 * `SettingsPanel` persistently on every `/projects/[id]/*` route, so this
 * page's job is the same as its two project-scoped siblings: set store state,
 * then leave. There is no project-scoped page to bounce back to from here —
 * this route has no `[id]` — so it resolves through `PROJECT_LANDING_PATH`,
 * the same id-free landing door every other "we don't know which project"
 * caller uses (see `lib/onboarding/landing-destination.ts`). It paints
 * instantly and lands on a real project page, which mounts the panel and
 * shows the overlay already open on the requested tab — this is what fixes
 * the previous "closing the overlay leaves a blank page" bug: this route no
 * longer stays mounted long enough for that blank page to exist.
 *
 * An unparseable segment still opens the overlay — on the default tab,
 * rather than bouncing to `/settings/<default>` first, since either way this
 * page immediately leaves for `PROJECT_LANDING_PATH`.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { DEFAULT_SETTINGS_TAB, parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function SettingsTabPage() {
  const params = useParams<{ tab: string }>();
  const tab = parseSettingsTab(params?.tab) ?? DEFAULT_SETTINGS_TAB;
  const router = useRouter();

  useEffect(() => {
    useSettingsPanelStore.getState().openSettings(tab);
    router.replace(PROJECT_LANDING_PATH);
  }, [tab, router]);

  return null;
}
