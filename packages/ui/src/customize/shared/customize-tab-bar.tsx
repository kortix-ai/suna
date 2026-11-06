'use client';

/**
 * Customize's top bar, over every Customize page, the agent pages included:
 * Agents, a separator, the workspace's libraries (each a link into its section
 * of Workspace settings), Review, then one "Workspace settings" link on the
 * right. Prod's layout (Jay, 2026-10-29): one row of tabs, no second column
 * beside the sidebar.
 *
 * Workspace settings (`/workspaces/<id>/admin/<section>`) draws no tab bar:
 * its one rail is the navigation (design.md §3.2 C7). `SettingsFrame` gives it
 * the same title-bar row (the sidebar opener and the window's drag region)
 * with the panel's name only.
 *
 * Both frames tell the page headers below (`useInCustomizeFrame`) that the
 * bar is the window's title-bar row and holds the sidebar opener, so they do
 * not draw a second.
 *
 * The tabs a caller sees follow the same rules as the pages: Review and
 * Settings by `capabilityAccess`, each library by its row's capability
 * and the `drives` flag (`PROJECT_ADMIN_RESOURCES`).
 */

import { useFeatureFlag } from '@kortix/sdk/react';
import { createContext, type ReactNode, useContext } from 'react';

import { useTranslations } from '../../i18n';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import { adminPath } from '../../lib/routes';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import {
  PROJECT_ADMIN_RESOURCES,
  isProjectAdminResource,
  parseProjectAdminSection,
  projectAdminHref,
  sectionLabelKey,
} from '../project-settings/project-admin-sections';
import { receivedDenial } from './capability-access-gate';

const InCustomizeFrame = createContext(false);

/** True under `CustomizeFrame`: the bar above holds the title-bar row and the sidebar opener. */
export function useInCustomizeFrame(): boolean {
  return useContext(InCustomizeFrame);
}

/** The bar, then the page. Every Customize route renders through it, the
 *  Agents list and each agent's page included. */
export function CustomizeFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  return (
    <InCustomizeFrame.Provider value>
      <CustomizeTabBar projectId={projectId} />
      {children}
    </InCustomizeFrame.Provider>
  );
}

/** Workspace settings' frame: the title-bar row with the sidebar opener and the panel's name, then the panel. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const tSettings = useTranslations('workspaces.settings');
  const sidebar = useOptionalSidebar();
  return (
    <InCustomizeFrame.Provider value>
      <div
        className="kx-titlebar-row kx-capability-titlebar relative flex h-11 shrink-0 items-center gap-1 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <h1 className="text-foreground truncate px-2 text-sm font-medium">{tSettings('title')}</h1>
      </div>
      {children}
    </InCustomizeFrame.Provider>
  );
}

const TAB_CLASS = 'w-fit flex-none px-1 py-3';
const SETTINGS_LINK_CLASS =
  'text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-1 py-3 text-sm font-medium whitespace-nowrap transition-colors';

/** The active tab: `/admin/<library>` that library, Review, or any settings section Settings. */
function activeTab(pathname: string): string {
  if (/\/customize\/agents(\/|$)/.test(pathname)) return 'agents';
  if (/\/customize\/review(\/|$)/.test(pathname)) return 'review';
  const section = pathname.match(/\/admin\/([^/?#]+)/)?.[1];
  const key = parseProjectAdminSection(section);
  if (!key) return '';
  return isProjectAdminResource(key) ? key : 'settings';
}

/**
 * The one way from Customize into Workspace settings. A caller who may not
 * open General (a member who reads Members only) lands on the first section
 * they may open: `/admin` picks it.
 */
function WorkspaceSettingsLink({ projectId, config }: { projectId: string; config: boolean }) {
  const tSettings = useTranslations('workspaces.settings');
  const canReadMembers = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_MEMBERS_READ];
  if (!config && receivedDenial(canReadMembers)) return null;
  return (
    <Link href={adminPath(projectId)} prefetch className={SETTINGS_LINK_CLASS}>
      {tSettings('title')}
    </Link>
  );
}

export function CustomizeTabBar({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tTabs = useTranslations('agentEditor.tabs');
  const tSettings = useTranslations('workspaces.settings');
  const pathname = useUiPathname() ?? '';
  const sidebar = useOptionalSidebar();
  const access = useCapabilityAccess(projectId);
  const drives = useFeatureFlag(projectId, 'drives');
  const allowed = new Set(access.tabs);

  const libraries = PROJECT_ADMIN_RESOURCES.filter(
    (r) => !r.host && (!r.capability || allowed.has(r.capability)) && (r.flag !== 'drives' || drives.enabled),
  );
  const tab = (value: string, href: string, label: string) => (
    <TabsTrigger key={value} value={value} asChild className={TAB_CLASS}>
      <Link href={href} prefetch>
        {label}
      </Link>
    </TabsTrigger>
  );

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <FadedScrollArea orientation="horizontal" fadeColor="from-background" rootClassName="min-w-0 flex-1">
        <Tabs value={activeTab(pathname)} className="w-max min-w-full">
          <TabsList
            type="underline"
            underlineSize="md"
            size="lg"
            className={cn('h-auto w-full justify-start gap-5 border-b-0 px-2', !access.settled && 'invisible')}
            aria-busy={!access.settled || undefined}
          >
            {allowed.has('agent') ? (
              <>
                {tab('agents', capabilityTabHref(projectId, 'agent'), tI18nComplete.raw('text279b44d2ab4b'))}
                {/* Agents are the object everything else is granted to: the rule sets them apart from the libraries. */}
                <span aria-hidden className="bg-border h-4 w-px shrink-0 self-center" />
              </>
            ) : null}
            {libraries.map((r) => {
              return tab(r.key, projectAdminHref(projectId, r.key), tSettings(`sections.${sectionLabelKey(r.key)}`));
            })}
            {allowed.has('review') ? tab('review', capabilityTabHref(projectId, 'review'), tTabs('review')) : null}
            {/* The right edge: the one link into Workspace settings. */}
            <span className="ml-auto flex items-center gap-5">
              <WorkspaceSettingsLink projectId={projectId} config={allowed.has('config')} />
            </span>
          </TabsList>
        </Tabs>
      </FadedScrollArea>
    </div>
  );
}
