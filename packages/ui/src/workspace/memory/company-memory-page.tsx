'use client';

import { useTranslations } from '../../i18n';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { MEMORY_HISTORY_PARAM, MEMORY_LAYER_PARAM, MEMORY_PAGE_PARAM, MemoryView, MY_KORTIX_MEMORY_LAYER } from './memory-view';

/**
 * The project's Memory page: the Company layer, what every agent in the
 * project knows, and the viewer's My Kortix memory, what My Kortix remembers
 * about them (`?layer=mykortix`). The titlebar row of a channel, then the
 * same `MemoryView` a channel's Memory tab draws. `company: false` (the host's
 * `project_channels` is off) shows the My Kortix memory alone.
 */
export function CompanyMemoryPage({ projectId, company = true }: { projectId: string; company?: boolean }) {
  const t = useTranslations('spaces.memory.company');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const layer = !company || searchParams.get(MEMORY_LAYER_PARAM) === MY_KORTIX_MEMORY_LAYER ? MY_KORTIX_MEMORY_LAYER : 'company';
  const mine = layer === MY_KORTIX_MEMORY_LAYER;

  const switchTo = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MEMORY_PAGE_PARAM);
    params.delete(MEMORY_HISTORY_PARAM);
    if (next === MY_KORTIX_MEMORY_LAYER) params.set(MEMORY_LAYER_PARAM, next);
    else params.delete(MEMORY_LAYER_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-2 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-baseline gap-2 px-2">
          <h1 className="shrink-0 self-center text-lg font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground min-w-0 truncate self-center text-xs">{t(mine ? 'subtitleMyKortix' : 'subtitle')}</p>
        </div>
        {company ? (
          <Tabs value={layer} onValueChange={switchTo} className="shrink-0 pr-2">
            <TabsList variant="segmented" aria-label={t('layers')}>
              <TabsTrigger value="company">{t('place')}</TabsTrigger>
              <TabsTrigger value={MY_KORTIX_MEMORY_LAYER}>{t('placeMyKortix')}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>
      {/* Out of flow, as in a channel: the shell's wrapper is `min-h-svh`, so a body with an
          intrinsic height (the All cards) would grow the page and scroll this header away. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 flex flex-col">
          <MemoryView key={layer} projectId={projectId} layerKey={layer} place={t(mine ? 'placeMyKortix' : 'place')} />
        </div>
      </div>
    </div>
  );
}
