'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  capabilityTabHref,
  channelsHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { VoiceView } from '@/features/workspace/customize/sections/view/voice-view';
import { ExperimentalTab } from '@/features/workspace/settings/tabs/experimental-tab';
import { GeneralTab } from '@/features/workspace/settings/tabs/general-tab';
import { SandboxTab } from '@/features/workspace/settings/tabs/sandbox-tab';
import { SnapshotsTab } from '@/features/workspace/settings/tabs/snapshots-tab';
import {
  SettingsNavProvider,
  type SettingsNav,
} from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  type ProjectAction,
} from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';

import {
  DEFAULT_PROJECT_SETTINGS_SECTION,
  parseProjectSettingsSection,
  projectSettingsSectionHref,
  projectSettingsSections,
  type ProjectSettingsSection,
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
 * **The rail is one flat list.** Desktop and mobile both render every visible
 * section as a single `TabsList`, in the order `projectSettingsSections()`
 * returns them. The three rail headings that came along from the overlay
 * (`Workspace` / `Agent` / `Advanced`) are gone — see
 * `project-settings-sections.ts`'s "One flat list, no headings". Do not
 * reintroduce them, and do not fake them with an extra gap between rows.
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
  const isMobile = useIsMobile();
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
  const projectCan = useCallback(
    (action: ProjectAction) => caps[action]?.allowed === true,
    [caps],
  );

  const voiceEnabled = project?.experimental?.voice ?? false;
  const reviewEnabled = project?.experimental?.review_center ?? false;

  const sections = useMemo(() => {
    const all = projectSettingsSections({ reviewEnabled, voiceEnabled });
    if (!capsResolved) return all;
    return all.filter((s) => isCustomizeSectionVisible(s.gate, projectCan));
  }, [reviewEnabled, voiceEnabled, capsResolved, projectCan]);

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
    () => buildProjectSettingsNav({ projectId, section: active, membersTab, navigateTo }),
    [projectId, active, membersTab, navigateTo],
  );

  const activeSection = sections.find((s) => s.key === active);

  return (
    <SettingsNavProvider value={settingsNav}>
      <div
        className={cn(
          'min-h-0 flex-1',
          isMobile ? 'flex flex-col overflow-hidden' : 'grid grid-cols-[230px_1fr] overflow-hidden',
        )}
      >
        {isMobile ? (
          <nav
            aria-label="Project settings"
            className="border-border/60 bg-background flex h-auto shrink-0 items-center border-b"
          >
            <FadedScrollArea
              orientation="horizontal"
              fadeColor="from-background"
              className="min-w-0 flex-1 py-2"
            >
              <Tabs value={active} className="w-fit">
                <TabsList orientation="horizontal" className="w-fit gap-1 px-2">
                  {sections.map((section) => (
                    <SectionTrigger
                      key={section.key}
                      projectId={projectId}
                      section={section}
                      horizontal
                      count={section.key === 'review' ? reviewNeedsYou : undefined}
                      attention={section.key === 'upgrades' && upgradeAttention}
                    />
                  ))}
                </TabsList>
              </Tabs>
            </FadedScrollArea>
          </nav>
        ) : (
          <section className="bg-background flex min-h-0 flex-col overflow-y-auto border-r py-4">
            <nav aria-label="Project settings" className="min-h-0 flex-1 px-2.5">
              {/* ONE flat list — no group headings, no extra gap standing in
                  for one. See `project-settings-sections.ts`'s
                  "One flat list, no headings". */}
              <Tabs value={active} orientation="vertical">
                <TabsList orientation="vertical" className="w-full">
                  {sections.map((section) => (
                    <SectionTrigger
                      key={section.key}
                      projectId={projectId}
                      section={section}
                      count={section.key === 'review' ? reviewNeedsYou : undefined}
                      attention={section.key === 'upgrades' && upgradeAttention}
                    />
                  ))}
                </TabsList>
              </Tabs>
            </nav>
          </section>
        )}

        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex min-h-0 w-full flex-1 flex-col space-y-6 overflow-y-auto px-4 py-10 pb-20 lg:py-14">
            {activeSection ? (
              <ProjectSettingsSectionPane sectionKey={activeSection.key} projectId={projectId} />
            ) : null}
          </div>
        </main>
      </div>
    </SettingsNavProvider>
  );
}

/**
 * One sub-nav row. A real `<Link prefetch>` inside the `TabsTrigger`, not an
 * `onValueChange` push: the section is URL state, so it has to be a link a
 * person can middle-click, copy, and land on directly.
 */
function SectionTrigger({
  projectId,
  section,
  count,
  attention,
  horizontal = false,
}: {
  projectId: string;
  section: ProjectSettingsSection;
  count?: number;
  attention?: boolean;
  horizontal?: boolean;
}) {
  const Icon = section.icon;
  const showCount = count != null && count > 0;
  return (
    <TabsTrigger
      value={section.key}
      asChild
      className={cn(
        'gap-2.5 py-0.75',
        horizontal
          ? 'w-auto shrink-0 px-3 whitespace-nowrap'
          : 'hover:data-[state=inactive]:bg-secondary data-[state=active]:bg-secondary w-full justify-start',
      )}
    >
      <Link href={projectSettingsSectionHref(projectId, section.key)} prefetch>
        <Icon className="size-4 shrink-0" />
        <span className={cn(!horizontal && 'truncate')}>{section.label}</span>
        {showCount ? (
          <Badge variant="kortix" size="xs" className={cn('tabular-nums', !horizontal && 'ml-auto')}>
            {count}
          </Badge>
        ) : attention ? (
          <span
            aria-hidden
            className={cn(
              'bg-kortix-orange size-1.5 shrink-0 rounded-full',
              !horizontal && 'ml-auto',
            )}
          />
        ) : null}
      </Link>
    </TabsTrigger>
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
    case 'voice':
      return <VoiceView projectId={projectId} />;
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
export function projectCapabilityNavTarget(tab: string): CapabilityTab['key'] | null {
  if (tab.startsWith('llm-')) return 'models';
  // Channels is no longer a tab of its own — it is a scope of Connectors. The
  // PAGE is the target; `projectCapabilityNavHref` adds the scope.
  if (tab === 'channels') return 'connectors';
  if (tab === 'secrets') return 'secrets';
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
  target: CapabilityTab['key'],
): string {
  return tab === 'channels' ? channelsHref(projectId) : capabilityTabHref(projectId, target);
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
      const overlayTab = parseSettingsTab(tab);
      if (overlayTab) useSettingsPanelStore.getState().openSettings(overlayTab);
    },
  };
}
