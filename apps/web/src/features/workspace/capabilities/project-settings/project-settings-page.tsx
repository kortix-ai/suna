'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import {
  capabilityTabHref,
  channelsHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { ExperimentalTab } from '@/features/workspace/settings/tabs/experimental-tab';
import { GeneralTab } from '@/features/workspace/settings/tabs/general-tab';
import { SandboxTab } from '@/features/workspace/settings/tabs/sandbox-tab';
import { SnapshotsTab } from '@/features/workspace/settings/tabs/snapshots-tab';
import {
  SettingsNavProvider,
  type SettingsNav,
} from '@/features/workspace/shared/settings-nav-context';
import {
  SettingsRail,
  SettingsShell,
  type SettingsRailGroup,
} from '@/features/workspace/shared/settings-shell';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  type ProjectAction,
} from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import {
  ACCOUNT_GRADUATED,
  isAccountGraduatedSection,
  parseSettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';

import {
  DEFAULT_PROJECT_SETTINGS_SECTION,
  parseProjectSettingsSection,
  projectSettingsSectionHref,
  projectSettingsSections,
  type ProjectSettingsSectionKey,
} from './project-settings-sections';

/**
 * The page body for `/projects/[id]/config` — the Customize bar's "Settings"
 * tab, and the home of the PROJECT-scoped configuration that is not important
 * enough to earn its own top-level Customize tab.
 *
 * These six sections used to live in the Settings overlay behind the
 * sidebar's gear icon, in its `Workspace` and `Agent` rail groups plus the
 * pinned Upgrades row and the `experimental` row. They configure a project, and
 * the person allowed to change them is already the person who can open
 * Customize — a second overlay with a second rail and a second keyboard
 * shortcut was one surface too many. The overlay keeps what is genuinely
 * user- or account-scoped: You, Organization, API keys.
 *
 * Models and Secrets moved a second time, off this page entirely and onto
 * their own top-level Customize tabs — see `capability-tab-routes.ts`.
 * Channels moved with them and then folded into the Connectors page as a
 * scope (`channelsHref`).
 * Marketplace, Review, and Voice were removed from the product outright.
 * Sandbox templates and Snapshots merged into one `sandbox` section.
 *
 * **The rail is one flat list of sections**, in the order
 * `projectSettingsSections()` returns them — no group HEADINGS. The three
 * rail headings that came along from the overlay (`Workspace` / `Agent` /
 * `Advanced`) are gone; see `project-settings-sections.ts`'s "One flat list,
 * no headings". Do not reintroduce those headings.
 *
 * **The desktop rail's SHELL is the account settings page's**
 * (`app/(app)/accounts/[id]/page.tsx`'s `<aside>`): a `208px` column, no
 * border and no rule, and rows in that page's `NAV_GROUPS` dialect — same
 * `h-8 rounded-sm px-2.5 gap-2.5`, same `size-4` icon, same
 * `bg-primary/[0.06]` active fill and `hover:bg-accent` otherwise. It is ONE
 * list under the hood (`sections.map`, a single `TabsList`); mobile keeps the
 * separate horizontal tab strip, unchanged, since it has no rail to match
 * shells with.
 *
 * Two things the account rail has that this one must NOT grow back:
 *
 *  - **No identity header.** The account rail's avatar + name block is the
 *    only place that page names the account. Here it was the second — the app
 *    sidebar carries this project's avatar and name two columns to the left,
 *    at the same `md` size — so the rail repeated it.
 *  - **No `border-r`.** The account rail is nav sitting in the page, separated
 *    by its grid column, not a boxed panel. The rule here drew a third
 *    vertical edge next to the sidebar's, and boxed in the repetition above.
 *
 * **The section lives in the URL, not in a store.** `?section=<key>` is
 * shareable, survives a reload, and is what `settings-tabs.ts`'s `GRADUATED`
 * map points every retired `/settings/<tab>` bookmark at. No query means the
 * default section (`general`), so `/projects/<id>/config` is a stable link.
 *
 * **Only the active section mounts.** Every pane fetches on mount, and six
 * panes mounting at once would fire six query sets for the one a person is
 * reading. This mirrors the overlay's `SettingsTabPane`, which returned `null`
 * for every inactive tab for the same reason.
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;

  const caps = useProjectCans(projectId, CUSTOMIZE_SECTION_GATE_ACTIONS, {
    accountId: project?.account_id,
  });
  // Fail-open while the probes are in flight — same rule the overlay used: a
  // section only disappears on a denial actually received, so a slow
  // capability call never blanks the sub-nav for someone who does have access.
  const capsResolved = useMemo(
    () =>
      CUSTOMIZE_SECTION_GATE_ACTIONS.every(
        (action) => caps[action] && !caps[action].isLoading && !caps[action].isError,
      ),
    [caps],
  );
  const projectCan = useCallback((action: ProjectAction) => caps[action]?.allowed === true, [caps]);

  const reviewEnabled = project?.experimental?.review_center ?? false;

  const sections = useMemo(() => {
    const all = projectSettingsSections({ reviewEnabled });
    if (!capsResolved) return all;
    return all.filter((s) => isCustomizeSectionVisible(s.gate, projectCan));
  }, [reviewEnabled, capsResolved, projectCan]);

  const requested = parseProjectSettingsSection(searchParams.get('section'));
  // A section named in the URL but hidden (flag off, or an explicit permission
  // deny) falls back to the first one this caller can actually open, so a
  // stale link lands on a real pane instead of an empty column.
  const active: ProjectSettingsSectionKey =
    (requested && sections.some((s) => s.key === requested) ? requested : undefined) ??
    (sections.some((s) => s.key === DEFAULT_PROJECT_SETTINGS_SECTION)
      ? DEFAULT_PROJECT_SETTINGS_SECTION
      : (sections[0]?.key ?? DEFAULT_PROJECT_SETTINGS_SECTION));

  // Pin Upgrades' attention dot only once the manifest read resolved to v1 —
  // while the detail query is in flight (or on a v2 project) the dot stays off.
  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // "Needs you" count for the Review row — the SAME shared inbox summary the
  // sidebar Review pill and the per-session dots read, so they cannot drift.
  const reviewNeedsYou = useReviewSessionSummary(projectId, {
    enabled: reviewEnabled,
  }).totalNeedsYou;

  // The one-shot Invite intent, set by the command palette before it routes
  // here. Reactive, so consuming it re-renders every `useSettingsNav()` reader.
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const navigateTo = useCallback((href: string) => router.push(href), [router]);
  const settingsNav = useMemo(
    () =>
      buildProjectSettingsNav({
        projectId,
        section: active,
        membersTab,
        accountId: project?.account_id,
        navigateTo,
      }),
    [projectId, active, membersTab, project?.account_id, navigateTo],
  );

  const activeSection = sections.find((s) => s.key === active);

  // The rail's groups: ONE unlabeled group, in the order
  // `projectSettingsSections()` returns them. The account rail's own
  // precedent for a cluster with nothing to split into — its leading
  // Settings/Git/Tokens group carries no label either. No group HEADINGS over
  // these four-to-six rows: Jay's 2026-08-17 call ("you don't need the
  // categories") stands. See `project-settings-sections.ts`'s "One flat list,
  // no headings".
  const railGroups: SettingsRailGroup[] = useMemo(
    () => [
      {
        items: sections.map((section) => ({
          id: section.key,
          label: section.label,
          icon: section.icon,
          // A real link, not an `onSelect` push: the section is URL state, so
          // it has to be something a person can middle-click and copy.
          href: projectSettingsSectionHref(projectId, section.key),
          count: section.key === 'review' ? reviewNeedsYou : undefined,
          attention: section.key === 'upgrades' && upgradeAttention,
        })),
      },
    ],
    [sections, projectId, reviewNeedsYou, upgradeAttention],
  );

  return (
    <SettingsNavProvider value={settingsNav}>
      {/* This page's ONE scroll container. It has to open its own:
          `(capabilities)/layout.tsx` is `h-svh … overflow-hidden` so the tab
          bar above cannot move, which means the window never scrolls here.
          `lg:sticky` on the rail resolves against THIS element.

          It carries NO padding of its own. A scroll container's own padding
          insets the rectangle a sticky descendant measures `top` against, so
          `py-10` here made the rail's `lg:top-8` push it 30px BELOW the
          heading beside it — at rest, with nothing scrolled. Measured on
          localhost:18000: aside top 117 vs heading top 87, and 87 with
          `top: 0`. The account hub never hit this; its scrollport is the
          window, which has no padding to inset. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* `CapabilityPageShell`'s column — same `px-4 py-10 pb-20 lg:py-14`
            and the same `max-w-5xl` ceiling as the six tabs beside it on the
            Customize bar. Without a column at all the rail sat hard against
            the app sidebar's edge with no left spacing.

            `lg:w-fit` is what makes the two gutters equal. Every pane here
            declares its own `mx-auto w-full max-w-2xl` (the settings width
            rule — `settings/tab-content-width.test.ts`), so a `1fr` content
            track hands the pane 742px of column that its ink only fills 672 of
            and re-centres inside. The block then sat 54px from the sidebar and
            89px from the right edge. Sizing the column to its content instead
            centres rail AND pane together as one block: measured on
            localhost:18000, left gutter 89 and right gutter 89. `w-full`
            below `lg`, where the shell is stacked and there is nothing to
            hug.

            The tradeoff, stated so nobody "fixes" it back: the hugged block is
            954px against the sibling tabs' 1024px column, so switching from
            Models to Settings shifts the left edge by 33px (ink at 346 vs
            313). Both cannot hold at once. Filling 1024 symmetrically would
            need a 112px rail gap — the account rail's is 44 — or a pane wider
            than `max-w-2xl`, which is the settings width rule that
            `settings/tab-content-width.test.ts` enforces across every pane
            these tabs also render in the overlay. A 33px hop between tabs is
            smaller than a 35px lopsided margin you sit and read inside. */}
        <div className="mx-auto w-full max-w-5xl px-4 py-10 pb-20 lg:w-fit lg:py-14">
          <SettingsShell
            activeKey={active}
            rail={
              <SettingsRail groups={railGroups} activeId={active} ariaLabel="Project settings" />
            }
          >
            {activeSection ? (
              <ProjectSettingsSectionPane sectionKey={activeSection.key} projectId={projectId} />
            ) : null}
          </SettingsShell>
        </div>
      </div>
    </SettingsNavProvider>
  );
}

/**
 * The pane for the active section. Every component is mounted exactly as the
 * overlay mounted it — same props, same order — so moving the surface changed
 * no pane's behavior, with one exception: `sandbox` now mounts BOTH
 * `SandboxTab` and `SnapshotsTab`, stacked, since the two merged into one
 * section (a snapshot is the build history of a sandbox template, not a
 * separate concept). Neither component was rewritten to do this — they are
 * just mounted together instead of on two different panes.
 */
function ProjectSettingsSectionPane({
  sectionKey,
  projectId,
}: {
  sectionKey: ProjectSettingsSectionKey;
  projectId: string;
}) {
  switch (sectionKey) {
    case 'general':
      return <GeneralTab projectId={projectId} />;
    case 'sandbox':
      return (
        <div className="space-y-8">
          <SandboxTab projectId={projectId} />
          <SnapshotsTab projectId={projectId} />
        </div>
      );
    case 'review':
      return <ReviewView projectId={projectId} />;
    case 'feature-flags':
      return <ExperimentalTab projectId={projectId} />;
    case 'upgrades':
      return <UpgradesView projectId={projectId} />;
  }
}

/**
 * Legacy nav ids, mapped to the section that owns them now. Panes still speak
 * the overlay's vocabulary — `git` now lands on General, since Repositories'
 * content merged into General's "Git repo" section rather than keeping its
 * own pane — and the seven `llm-*` sub-sections are all the Models pane,
 * which picks its own sub-tab.
 */
export function projectSettingsNavTarget(tab: string): ProjectSettingsSectionKey | null {
  if (tab === 'git') return 'general';
  if (tab === 'settings') return 'general';
  if (tab === 'experimental') return 'feature-flags';
  return parseProjectSettingsSection(tab);
}

/**
 * Legacy nav ids for the sections that graduated a SECOND time, off this page
 * and onto their own top-level Customize tab. A pane still calling
 * `navigate('llm-providers')`, `navigate('channels')`, or `navigate('members')`
 * (the overlay's old vocabulary) needs to leave this page entirely, not push a
 * `?section=` this page no longer recognizes.
 */
export function projectCapabilityNavTarget(tab: string): CapabilityTab['key'] | 'members' | null {
  if (tab.startsWith('llm-')) return 'models';
  // Channels is no longer a tab of its own — it is a scope of Connectors. The
  // PAGE is the target; `projectCapabilityNavHref` adds the scope.
  if (tab === 'channels') return 'connectors';
  if (tab === 'secrets') return 'secrets';
  // `'members'` — not a `CapabilityTab['key']` any more: Members graduated a
  // THIRD time, off the project entirely, onto the account hub's Access tab.
  // Still named here (rather than left to the `isAccountGraduatedSection`
  // fallback callers reach further down) so the result routes through
  // `/projects/<id>/members` — the redirect route
  // (`app/(app)/projects/[id]/(capabilities)/members/page.tsx`) that already
  // knows how to resolve `account_id` and append the `&project=` scoping —
  // instead of duplicating that resolution here.
  if (tab === 'members') return 'members';
  return null;
}

/**
 * The href a legacy nav id actually resolves to.
 *
 * For every id but one this is just the tab's route. `channels` is the
 * exception, and it is why this exists at all: its destination is a QUERY on
 * the Connectors page, and `capabilityTabHref` builds paths only. Returning
 * the bare Connectors route instead would land a person who asked for Slack on
 * the connector catalogue — the right page, showing the wrong half of it.
 */
export function projectCapabilityNavHref(
  projectId: string,
  tab: string,
  target: CapabilityTab['key'] | 'members',
): string {
  if (tab === 'channels') return channelsHref(projectId);
  // `'members'` is not a real `CapabilityTab['key']` — `capabilityTabHref`
  // would reject it at the type level. The literal route it used to build is
  // still the right destination: the redirect page at that path.
  if (target === 'members') return `/projects/${projectId}/members`;
  return capabilityTabHref(projectId, target);
}

/**
 * The `SettingsNav` adapter for this page — the second host of that context,
 * which is exactly what it was kept panel-agnostic for. Pure and exported so
 * its navigation rules are testable without mounting the page, the same shape
 * as `settings-panel.tsx`'s `buildSettingsPanelSettingsNav`.
 *
 * `navigate(tab)` is called from panes that still speak the overlay's
 * vocabulary, and it has three destinations:
 *
 *  1. A section on THIS page — `git`, `experimental` — pushed as a URL, so
 *     the sub-nav and the browser history stay in step. Navigating to the
 *     section already shown pushes nothing: `consumeMembersTabIntent` calls
 *     `navigate(activeTab, …)` purely to clear its one-shot intent.
 *  2. A tab that graduated a second time onto its own top-level Customize
 *     tab — `llm-providers` (Models), `channels`, `secrets` — routed there
 *     directly, since this page no longer has a pane for any of them.
 *  3. A tab that stayed in the overlay (`profile`, `preferences`,
 *     `connected`) — opens the overlay on it, since that is where it lives.
 *
 * `membersTab` still rides on the settings-panel store. It is a one-shot
 * deep-link intent ("land on Invite"), set by the command palette before it
 * routes here and cleared by the Members pane the moment it consumes it — see
 * `settings/tabs/members-tab-intent.ts`. It is store state rather than a query
 * param because it must not survive a reload or a shared link.
 */
export function buildProjectSettingsNav(state: {
  projectId: string;
  section: ProjectSettingsSectionKey;
  membersTab: MembersTab;
  /** See the identical field on `buildStandaloneCapabilityNav` — resolves
   *  `ACCOUNT_GRADUATED` ids (`groups`, `roles`, ...) to `/accounts/<id>`. */
  accountId?: string;
  navigateTo: (href: string) => void;
}): SettingsNav {
  return {
    activeTab: state.section,
    isOpen: true,
    membersTab: state.membersTab,
    llmProvidersTab: undefined,
    navigate: (tab, opts) => {
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
      const target = projectSettingsNavTarget(tab);
      if (target) {
        if (target !== state.section) {
          state.navigateTo(projectSettingsSectionHref(state.projectId, target));
        }
        return;
      }
      const capabilityTarget = projectCapabilityNavTarget(tab);
      if (capabilityTarget) {
        state.navigateTo(projectCapabilityNavHref(state.projectId, tab, capabilityTarget));
        return;
      }
      // See `standalone-settings-nav.ts`'s identical branch (and its comment
      // on why this is NOT `legacySectionRedirect`): without this,
      // `navigate('groups')` / `navigate('roles')` matched nothing and did
      // nothing at all.
      if (state.accountId && isAccountGraduatedSection(tab)) {
        state.navigateTo(`/accounts/${state.accountId}?tab=${ACCOUNT_GRADUATED[tab]}`);
        return;
      }
      const overlayTab = parseSettingsTab(tab);
      if (overlayTab) useSettingsPanelStore.getState().openSettings(overlayTab);
    },
  };
}
