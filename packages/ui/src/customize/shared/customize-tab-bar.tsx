'use client';

/**
 * Customize's top bar, over every Customize and Project admin page: the
 * project's libraries (Connectors, Secrets, Skills, Tools, Extensions, Drives,
 * Triggers, Models, Repo), Review, then Members ↗ and Settings on the right.
 * Agents are not a tab: the sidebar's Customize lists them. Prod's layout (Jay, 2026-10-29): one row of tabs,
 * no second column beside the sidebar. A library tab opens its Project admin
 * page full width; Settings opens Project admin's settings sections, which
 * keep a short sub-nav of their own.
 *
 * `CustomizeFrame` draws the bar above its children and tells the page
 * headers below it (`useInCustomizeFrame`) that the bar is the window's
 * title-bar row and holds the sidebar opener, so they do not draw a second.
 *
 * The tabs a caller sees follow the same rules as the pages: Review and
 * Settings by `capabilityAccess`, each library by its row's capability
 * and the `drives` flag (`PROJECT_ADMIN_RESOURCES`).
 */

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';

import { useTranslations } from '../../i18n';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import { hubTarget } from '../../internal/stores/account-panel-store';
import { adminPath } from '../../lib/routes';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import {
  PROJECT_ADMIN_RESOURCES,
  RESOURCE_LABEL_KEYS,
  isProjectAdminResource,
  parseProjectAdminSection,
  projectAdminHref,
} from '../../workspace/admin/project-admin-sections';
import { receivedDenial } from './capability-access-gate';

const InCustomizeFrame = createContext(false);

/** True under `CustomizeFrame`: the bar above holds the title-bar row and the sidebar opener. */
export function useInCustomizeFrame(): boolean {
  return useContext(InCustomizeFrame);
}

/** The bar, then the page. Every Customize and Project admin route renders through it,
 *  except the agents' own pages (`/customize/agents/…`): an agent is reached from the
 *  sidebar's Customize and keeps its own header, with no bar over it. */
export function CustomizeFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  const pathname = useUiPathname() ?? '';
  if (/\/customize\/agents(\/|$)/.test(pathname)) return <>{children}</>;
  return (
    <InCustomizeFrame.Provider value>
      <CustomizeTabBar projectId={projectId} />
      {children}
    </InCustomizeFrame.Provider>
  );
}

const TAB_CLASS = 'w-fit flex-none px-1 py-3';
const MEMBERS_LINK_CLASS =
  'text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-1 py-3 text-sm font-medium whitespace-nowrap transition-colors';

/** The active tab: `/admin/<library>` that library, Review, or any settings section Settings. */
function activeTab(pathname: string): string {
  if (/\/customize\/review(\/|$)/.test(pathname)) return 'review';
  const section = pathname.match(/\/admin\/([^/?#]+)/)?.[1];
  const key = parseProjectAdminSection(section);
  if (!key) return '';
  return isProjectAdminResource(key) ? key : 'settings';
}

function MembersLink({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const canReadMembers = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_MEMBERS_READ];
  const accountId = data?.project?.account_id;
  if (receivedDenial(canReadMembers) || !accountId) return null;
  return (
    <HubLink to={hubTarget(accountId, { tab: 'access-projects', project: projectId })} className={MEMBERS_LINK_CLASS}>
      {tI18nComplete.raw('text1044a4c056d0')}
      <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
    </HubLink>
  );
}

export function CustomizeTabBar({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tTabs = useTranslations('agentEditor.tabs');
  const tAdmin = useTranslations('projectAdmin');
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
            {libraries.map((r) => {
              const legacy = RESOURCE_LABEL_KEYS[r.key];
              return tab(r.key, projectAdminHref(projectId, r.key), legacy ? tI18nComplete.raw(legacy) : tAdmin(r.key));
            })}
            {allowed.has('review') ? tab('review', capabilityTabHref(projectId, 'review'), tTabs('review')) : null}
            {/* The right edge: Members (the account hub) and Settings, together so Settings stays right when Members hides. */}
            <span className="ml-auto flex items-center gap-5">
              <MembersLink projectId={projectId} />
              {allowed.has('config') ? tab('settings', adminPath(projectId, 'general'), tTabs('settings')) : null}
            </span>
          </TabsList>
        </Tabs>
      </FadedScrollArea>
    </div>
  );
}
