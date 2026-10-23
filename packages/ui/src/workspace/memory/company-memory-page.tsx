'use client';

import { useTranslations } from '../../i18n';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { MemoryView } from './memory-view';

/**
 * The project's Memory page: the Company layer, what every agent in the
 * project knows. The titlebar row of a channel, then the same `MemoryView` a
 * channel's Memory tab draws. The host gates it on `project_channels`.
 */
export function CompanyMemoryPage({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.memory.company');
  const sidebar = useOptionalSidebar();
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-2 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-baseline gap-2 px-2">
          <h1 className="shrink-0 self-center text-lg font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground min-w-0 truncate self-center text-xs">{t('subtitle')}</p>
        </div>
      </div>
      <MemoryView projectId={projectId} layerKey="company" place={t('place')} />
    </div>
  );
}
