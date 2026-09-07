'use client';

/**
 * `SettingsNav` adapter for a standalone capability page — Models, Secrets,
 * Members today. Each of those mounts a component (`ModelsTab`, `SecretsView`,
 * `MembersTab`, ...) built to run inside the Settings overlay, and that host
 * provides a `SettingsNav` via `SettingsNavProvider`. A standalone tab
 * mounting the same component without a provider crashes on the first
 * `useSettingsNav()` call — `useSettingsNav()` throws on purpose rather than
 * silently no-op'ing, exactly so this can't go unnoticed. This hook is that
 * missing provider's value.
 *
 * Almost no "local" tab case here — a standalone page IS its own destination —
 * so `navigate(tab)` skips a route push only when `tab` names the page it is
 * already on (see `capabilityTarget !== state.activeTab` below); Members
 * needs exactly this for `consumeMembersTabIntent`, which re-asserts the
 * current tab purely to clear its one-shot intent. Every other target is a
 * sibling top-level Customize tab, the account page, or the Settings overlay
 * — the config page that used to be a fourth destination was retired on
 * 2026-09-02, and every id that named one of its sections resolves to an
 * overlay tab now (`resolveOverlayTab`).
 */
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import {
  ACCOUNT_GRADUATED,
  isAccountGraduatedSection,
  resolveOverlayTab,
} from '@/features/workspace/settings/settings-tabs';
import type { SettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';

import { capabilityTabHref, channelsHref, type CapabilityTab } from './capability-tab-routes';

/**
 * Legacy nav ids for the surfaces that are top-level Customize tabs. A pane
 * still calling `navigate('llm-providers')`, `navigate('channels')`,
 * `navigate('review')` or `navigate('members')` (the overlay's old
 * vocabulary) needs to leave the page it is on, not open the overlay.
 */
export function projectCapabilityNavTarget(tab: string): CapabilityTab['key'] | 'members' | null {
  if (tab.startsWith('llm-')) return 'models';
  // Channels is no longer a tab of its own — it is a scope of Connectors. The
  // PAGE is the target; `projectCapabilityNavHref` adds the scope.
  if (tab === 'channels') return 'connectors';
  if (tab === 'secrets') return 'secrets';
  // Review — its own tab since 2026-09-02, when the config page it was a
  // section of was retired.
  if (tab === 'review') return 'review';
  // `'members'` — not a `CapabilityTab['key']`: Members graduated off the
  // project entirely, onto the account hub's Access tab. Still named here
  // (rather than left to the `isAccountGraduatedSection` fallback) so the
  // result routes through `/projects/<id>/members` — the redirect route that
  // already knows how to resolve `account_id` and append the `&project=`
  // scoping — instead of duplicating that resolution here.
  if (tab === 'members') return 'members';
  return null;
}

/**
 * The href a legacy nav id actually resolves to.
 *
 * For every id but one this is just the tab's route. `channels` is the
 * exception, and it is why this exists at all: its destination is a QUERY on
 * the Connectors page, and `capabilityTabHref` builds paths only.
 */
export function projectCapabilityNavHref(
  projectId: string,
  tab: string,
  target: CapabilityTab['key'] | 'members',
): string {
  if (tab === 'channels') return channelsHref(projectId);
  // `'members'` is not a real `CapabilityTab['key']` — `capabilityTabHref`
  // would reject it at the type level. The redirect page at that path is
  // still the right destination.
  if (target === 'members') return `/projects/${projectId}/members`;
  return capabilityTabHref(projectId, target);
}

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
  /** Resolves `ACCOUNT_GRADUATED` ids (`groups`, `roles`, ...) to
   *  `/accounts/<id>?tab=<...>`. Undefined while the project detail that
   *  yields it is still loading — those ids no-op rather than mis-navigate,
   *  same fail-open rule the capability-tab probes use. */
  accountId?: string;
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
      const capabilityTarget = projectCapabilityNavTarget(tab);
      if (capabilityTarget) {
        if (capabilityTarget !== state.activeTab) {
          state.navigateTo(projectCapabilityNavHref(state.projectId, tab, capabilityTarget));
        }
        return;
      }
      // Groups / Roles / Organization / ... — graduated OFF every project
      // surface entirely, onto the account page. Members' Access tab links to
      // both ("Create one in Groups", "Create one in Roles") and, without
      // this branch, `tab` matched none of the checks above or below and the
      // click did nothing at all. Deliberately NOT `legacySectionRedirect` —
      // that helper's own fallback also resolves overlay-still ids
      // (`preferences` -> `/projects/<id>/settings/preferences`, a route),
      // which would bypass the store-based `openSettings()` call below and
      // break this adapter's "opens the overlay, not a route" contract.
      if (state.accountId && isAccountGraduatedSection(tab)) {
        state.navigateTo(`/accounts/${state.accountId}?tab=${ACCOUNT_GRADUATED[tab]}`);
        return;
      }
      // Live overlay tabs AND the retired config page's ids (`general`, `git`,
      // `sandbox`, `experimental`, …) — every one is an overlay tab now.
      const overlayTab = resolveOverlayTab(tab);
      if (overlayTab) useSettingsPanelStore.getState().openSettings(overlayTab);
    },
  };
}

export function useStandaloneCapabilityNav(
  projectId: string,
  activeTab: string,
  accountId?: string,
): SettingsNav {
  const router = useRouter();
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const navigateTo = useCallback((href: string) => router.push(href), [router]);

  return useMemo(
    () => buildStandaloneCapabilityNav({ projectId, activeTab, membersTab, accountId, navigateTo }),
    [projectId, activeTab, membersTab, accountId, navigateTo],
  );
}
