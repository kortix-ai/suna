'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { HoverPrefetchLink } from '../../../internal/components/hover-prefetch-link';

import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';
import { appStatus, gridApps } from '../../../apps/app-shared';
import { Popover, PopoverAnchor } from '../../../primitives/popover';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../../primitives/input-group';
import { menuRow } from '../../../primitives/menu-recipe';
import { cn } from '../../../lib/utils';
import { NavHoverCardContent, NavHoverCardList, useNavHoverCard } from '../../../internal/layout/nav-hover-card';
import { useProjectApps } from '@kortix/sdk/react';
import type { App } from '@kortix/sdk';
import { AppWindowIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useUiPathname } from '../../../providers/ui-provider';
import { useRef, useState } from 'react';

/** Above this many Apps the card gets a search field. */
const SEARCH_THRESHOLD = 10;

/**
 * The Apps row shows to a caller who can deploy an App, or while the project
 * has an App they can open. A member who can do neither got an empty page
 * that told them to "ask an agent to build one". Nothing shows until both
 * answers land, so the row never appears and then vanishes.
 */
export function useAppsRowVisible(projectId: string | undefined): boolean {
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY);
  const apps = useProjectApps(projectId);
  if (canDeploy.allowed === true) return true;
  if (canDeploy.isLoading) return false;
  return (apps.data?.length ?? 0) > 0;
}

/**
 * The Apps row, with a hover card of the Apps the page shows as cards
 * (`gridApps`), so one click opens an App. A pick lands on `?app=<id>`, which
 * opens that App's detail on the page.
 */
export function ProjectAppsNavItem({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useAppsRowVisible(projectId);
  const apps = useProjectApps(projectId);
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const listed = apps.data ? gridApps(apps.data, canAdmin) : [];
  const card = useNavHoverCard({ enabled: listed.length > 0, holdRef: searchRef });
  const showSearch = listed.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? listed.filter((app) => app.name.toLowerCase().includes(needle) || app.slug.includes(needle))
    : listed;

  const href = projectId ? uiRoutes().apps(projectId) : null;
  if (!href || !visible) return null;
  const label = tI18nComplete.raw('text89dd748442c1');
  const close = () => card.setOpen(false);
  return (
    <Popover
      open={card.open}
      onOpenChange={(next) => {
        card.setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverAnchor virtualRef={card.anchorRef} />
      <ProjectNavRow
        active={pathname?.startsWith(href) === true}
        label={label}
        href={href}
        prefetch
        {...card.rowProps}
      >
        {/* shrink-0 so the glyph keeps its box when the label is long or the
                sidebar is narrow — the sibling rows wrap their icons the same way. */}
        <span className="shrink-0">
          <AppWindowIcon />
        </span>
        {label}
      </ProjectNavRow>
      <NavHoverCardContent {...card.contentProps}>
        {showSearch ? (
          <div className="border-border border-b p-1">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                ref={searchRef}
                variant="popover"
                size="xs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('searchApps')}
                aria-label={t('searchApps')}
              />
            </InputGroupSearch>
          </div>
        ) : null}
        <NavHoverCardList className="max-h-80 overflow-x-hidden overflow-y-auto overscroll-contain">
          {shown.map((app) => (
            <li key={app.app_id}>
              <AppRow app={app} href={`${href}?app=${encodeURIComponent(app.app_id)}`} onOpen={close} />
            </li>
          ))}
          {shown.length === 0 ? (
            <li className={menuRow('sm', 'default', 'text-muted-foreground pointer-events-none')}>
              {t('appsNoMatches')}
            </li>
          ) : null}
        </NavHoverCardList>
      </NavHoverCardContent>
    </Popover>
  );
}

/** One App: its name and the status dot the Apps page draws under its card. */
function AppRow({ app, href, onOpen }: { app: App; href: string; onOpen: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const status = appStatus(app, tI18nComplete);
  return (
    <HoverPrefetchLink href={href} onClick={onOpen} className={menuRow('sm', 'default', 'cursor-pointer')}>
      <span className="flex size-4 shrink-0 items-center justify-center" title={status.label}>
        <span aria-hidden className={cn('size-1.5 rounded-full', status.dot)} />
      </span>
      <span className="min-w-0 flex-1 truncate">{app.name}</span>
      <span className="sr-only">{status.label}</span>
    </HoverPrefetchLink>
  );
}
