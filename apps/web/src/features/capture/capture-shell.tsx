'use client';

import Link from 'next/link';
import { notFound, usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useTranslations } from '@/i18n/use-translations';

import { useCaptureViewer } from './use-capture-viewer';

type CaptureTab = 'timeline' | 'ask' | 'ranges' | 'devices' | 'people' | 'settings';

const TABS: readonly CaptureTab[] = ['timeline', 'ask', 'ranges', 'devices', 'people', 'settings'];
/** The path segment after `/capture` (Timeline is the index). */
const segmentOf = (tab: CaptureTab) => (tab === 'timeline' ? '' : `/${tab}`);

/** The tab a capture path belongs to (`/projects/p/capture/ranges/r1` → ranges). */
export function activeCaptureTab(pathname: string | null): CaptureTab {
  const rest = pathname?.split('/capture')[1] ?? '';
  const segment = rest.split('/')[1] ?? '';
  return TABS.find((tab) => tab !== 'timeline' && tab === segment) ?? 'timeline';
}

function CaptureTabs({ projectId, isManager }: { projectId: string; isManager: boolean }) {
  const t = useTranslations('capture.shell');
  const pathname = usePathname();
  const params = useSearchParams();
  const sidebar = useOptionalSidebar();
  const user = params.get('user');
  const tabs: CaptureTab[] = isManager
    ? ['timeline', 'ask', 'ranges', 'devices', 'people', 'settings']
    : ['timeline', 'ask', 'ranges', 'devices'];
  // A manager looking at a member keeps that member on the tabs that read one person.
  const href = (tab: CaptureTab) =>
    `/projects/${projectId}/capture${segmentOf(tab)}${user && (tab === 'timeline' || tab === 'ranges') ? `?user=${user}` : ''}`;

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <h1 className="sr-only">{t('title')}</h1>
      <FadedScrollArea
        orientation="horizontal"
        fadeColor="from-background"
        rootClassName="min-w-0 flex-1"
      >
        <Tabs value={activeCaptureTab(pathname)} className="w-max min-w-full">
          <TabsList
            type="underline"
            underlineSize="md"
            size="lg"
            className="kx-titlebar-tabs h-auto w-full justify-start gap-5 border-b-0 px-2"
          >
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab} asChild className="w-fit flex-none px-1 py-3">
                <Link href={href(tab)} prefetch={true}>
                  {t(`tabs.${tab}`)}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </FadedScrollArea>
    </div>
  );
}

/**
 * The Capture area's frame: the project's `capture` feature flag gates it
 * (off → 404, the same answer the API gives every capture route), and the tab
 * bar shows People and Settings to project managers only.
 */
export function CaptureShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const viewer = useCaptureViewer(projectId);
  if (viewer.isLoading) return <ProjectPendingScreen fill="pane" />;
  if (!viewer.enabled) notFound();
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <CaptureTabs projectId={projectId} isManager={viewer.isManager} />
      {children}
    </div>
  );
}

/** A manager-only page: a member who opens the URL gets the same 404 as a disabled flag. */
export function ManagersOnly({ projectId, children }: { projectId: string; children: ReactNode }) {
  const viewer = useCaptureViewer(projectId);
  if (viewer.isLoading) return null;
  if (!viewer.isManager) notFound();
  return <>{children}</>;
}
