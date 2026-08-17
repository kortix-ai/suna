'use client';

/**
 * `SettingsNav` adapter for a capability page that is neither the Settings
 * overlay nor `/projects/[id]/config` — Models, Secrets, Members today. Each of those mounts a component (`ModelsTab`, `SecretsView`,
 * `MembersTab`, ...) built to run inside the overlay or the config page's
 * sub-nav, and every one of those hosts provides a `SettingsNav` via
 * `SettingsNavProvider`. A standalone tab mounting the same component without
 * a provider crashes on the first `useSettingsNav()` call —
 * `useSettingsNav()` throws on purpose rather than silently no-op'ing,
 * exactly so this can't go unnoticed. This hook is that missing provider's
 * value.
 *
 * Almost no "local" tab case here — a standalone page IS its own destination —
 * so `navigate(tab)` skips a route push only when `tab` names the page it is
 * already on (see `capabilityTarget !== state.activeTab` below); Members
 * needs exactly this for `consumeMembersTabIntent`, which re-asserts the
 * current tab purely to clear its one-shot intent. Every other target
 * resolves through the same three-way lookup `project-settings-page.tsx`'s
 * adapter uses (a `/config` section, a sibling top-level Customize tab, or
 * the account/user overlay) and ends in an external navigation.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import {
  projectCapabilityNavHref,
  projectCapabilityNavTarget,
  projectSettingsNavTarget,
} from '@/features/workspace/capabilities/project-settings/project-settings-page';
import { projectSettingsSectionHref } from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import type { SettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';

/**
 * The pure half of the adapter, split out exactly the way
 * `project-settings-page.tsx`'s `buildProjectSettingsNav` is: so the
 * navigation rules are testable without mounting a hook. `navigateTo` stands
 * in for `router.push` — see `members-tab-intent.test.ts`, which drives this
 * directly to pin the one-shot `membersTab` intent across a Members page
 * mount/unmount without a React render harness.
 */
export function buildStandaloneCapabilityNav(state: {
  projectId: string;
  activeTab: string;
  membersTab: MembersTab;
  navigateTo: (href: string) => void;
}): SettingsNav {
  return {
    activeTab: state.activeTab,
    isOpen: true,
    membersTab: state.membersTab,
    llmProvidersTab: undefined,
    navigate: (tab, opts) => {
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
      const configTarget = projectSettingsNavTarget(tab);
      if (configTarget) {
        state.navigateTo(projectSettingsSectionHref(state.projectId, configTarget));
        return;
      }
      const capabilityTarget = projectCapabilityNavTarget(tab);
      if (capabilityTarget) {
        if (capabilityTarget !== state.activeTab) {
          state.navigateTo(projectCapabilityNavHref(state.projectId, tab, capabilityTarget));
        }
        return;
      }
      const overlayTab = parseSettingsTab(tab);
      if (overlayTab) useSettingsPanelStore.getState().openSettings(overlayTab);
    },
  };
}

export function useStandaloneCapabilityNav(projectId: string, activeTab: string): SettingsNav {
  const router = useRouter();
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const navigateTo = useCallback((href: string) => router.push(href), [router]);

  return useMemo(
    () => buildStandaloneCapabilityNav({ projectId, activeTab, membersTab, navigateTo }),
    [projectId, activeTab, membersTab, navigateTo],
  );
}
