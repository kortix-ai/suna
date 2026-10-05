'use client';

import { ArrowLeftIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { notFound, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { Button } from '@/components/ui/button';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useTranslations } from '@/i18n/use-translations';

import { useCaptureViewer } from './use-capture-viewer';

/**
 * The Capture area's frame. The timeline is the page; Ranges, People and
 * Settings are secondary pages reached from its menu. The project's `capture`
 * feature flag gates the whole area (off → 404, the API's answer too). The
 * area has no sidebar entry: it opens from a direct link, the desktop app and
 * the tray.
 */
export function CaptureShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const viewer = useCaptureViewer(projectId);
  if (viewer.isLoading) return <ProjectPendingScreen fill="pane" />;
  if (!viewer.enabled) notFound();
  return <div className="flex h-svh flex-col overflow-hidden">{children}</div>;
}

/** The title bar of a secondary page: back to the timeline (keeping `?user=`), and the page's name. */
export function CaptureSubpageHeader({ projectId, title }: { projectId: string; title: string }) {
  const t = useTranslations('capture.shell');
  const sidebar = useOptionalSidebar();
  const user = useSearchParams().get('user');
  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <Button asChild variant="ghost" size="sm" className="gap-1.5">
        <Link href={`/projects/${projectId}/capture${user ? `?user=${user}` : ''}`}>
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          {t('timeline')}
        </Link>
      </Button>
      <span aria-hidden className="bg-border mx-1 h-4 w-px shrink-0" />
      <span className="text-foreground truncate text-sm font-medium">{title}</span>
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
