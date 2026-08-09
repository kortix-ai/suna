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
 * Decision: `SettingsPanel`'s `projectId` prop is already optional and the
 * component already degrades gracefully with it unset — no project-detail
 * query runs, the IAM caps probe stays disabled, and `isTabAllowed` fails
 * open (shows every tab) because `capsResolved` can never become true
 * without a project. So this route passes no `projectId` at all rather than
 * inventing a "last active project" lookup or redirecting to a project
 * picker: nothing in this task's scope establishes what "no project
 * selected" should redirect to, the tabs this route exists for (profile,
 * billing, ...) are account-scoped and don't need one, and project-scoped
 * tabs opened from here just render their (currently placeholder) pane with
 * no project data until a real project is chosen some other way. Revisit
 * this if/when a project-scoped tab is opened from here and needs one.
 *
 * Same parse-or-redirect shape as `projects/[id]/settings/[tab]`, adapted
 * for having no bare `/settings` landing route to fall back to: an
 * unparseable segment redirects to `/settings/<DEFAULT_SETTINGS_TAB>`
 * instead.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import { DEFAULT_SETTINGS_TAB, parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function SettingsTabPage() {
  const params = useParams<{ tab: string }>();
  const tab = parseSettingsTab(params?.tab);
  const router = useRouter();

  useEffect(() => {
    if (!tab) {
      router.replace(`/settings/${DEFAULT_SETTINGS_TAB}`);
      return;
    }
    useSettingsPanelStore.getState().openSettings(tab);
  }, [tab, router]);

  if (!tab) return null;
  return <SettingsPanel />;
}
