'use client';

import { useTranslations } from 'next-intl';
/**
 * Apps overlay — the surface behind the Apps button in the project sidebar.
 *
 * Sibling to the Customize overlay (mounted once in `ProjectShell`). Shows
 * the project's `[[apps]]` entries with deploy status and lets the user
 * add/edit/remove apps + trigger deploys/stops/logs without leaving their
 * current session.
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ Apps · Project                              ✕  │
 *   ├───────────────────────────────────────────────┤
 *   │   • marketing-site   [Live]   marketing.dev   │
 *   │   • docs             [Live]   docs.dev        │
 *   │                                               │
 *   │   [ Add app ]                                  │
 *   └───────────────────────────────────────────────┘
 */

import { useQuery } from '@tanstack/react-query';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconApp, IconClose } from '@/components/ui/kortix-icons';
import { useProjectApps } from '@/hooks/projects/use-project-apps';
import { getProjectDetail } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useAppsOverlayStore } from '@/stores/apps-overlay-store';

import { AppForm } from './app-form';
import { AppLogs } from './app-logs';
import { AppsList } from './apps-list';

export function AppsOverlay({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const open = useAppsOverlayStore((s) => s.open);
  const section = useAppsOverlayStore((s) => s.section);
  const selectedSlug = useAppsOverlayStore((s) => s.selectedSlug);
  const setSection = useAppsOverlayStore((s) => s.setSection);
  const close = useAppsOverlayStore((s) => s.close);

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: open && !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const projectName = detail.data?.project?.name ?? '';

  const appsQuery = useProjectApps(open ? projectId : undefined);
  const existing = selectedSlug
    ? appsQuery.data?.apps.find((a) => a.slug === selectedSlug)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'h-[min(820px,calc(100dvh-1.5rem))] w-[calc(100vw-1.5rem)] max-w-[960px] sm:max-w-[960px]',
        )}
      >
        <DialogTitle className="sr-only">
          {tI18nHardcoded.raw('autoComponentsProjectsAppsAppsOverlayJsxTextApps825cf027')}
          {projectName || 'project'}
        </DialogTitle>

        {/* Header */}
        <div className="border-border/60 flex h-12 shrink-0 items-center justify-between border-b pr-2 pl-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <IconApp className="text-muted-foreground size-4 shrink-0" />
            <span className="text-foreground font-medium">
              {section === 'create' && 'Add app'}
              {section === 'edit' && `Edit · ${selectedSlug ?? ''}`}
              {section === 'logs' && `Logs · ${selectedSlug ?? ''}`}
              {section === 'list' && 'Apps'}
            </span>
            {projectName && section === 'list' && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground truncate">{projectName}</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors"
          >
            <IconClose className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="bg-background flex min-h-0 flex-1">
          {section === 'list' && (
            <AppsList
              projectId={projectId}
              data={appsQuery.data}
              isLoading={appsQuery.isLoading}
              onAdd={() => setSection('create')}
              onEdit={(slug) => setSection('edit', slug)}
              onLogs={(slug) => setSection('logs', slug)}
            />
          )}
          {section === 'create' && (
            <AppForm projectId={projectId} onDone={() => setSection('list')} />
          )}
          {section === 'edit' && existing && (
            <AppForm projectId={projectId} existing={existing} onDone={() => setSection('list')} />
          )}
          {section === 'edit' && !existing && !appsQuery.isLoading && (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              {tI18nHardcoded.raw('autoComponentsProjectsAppsAppsOverlayJsxTextThatAppNoe42e1373')}
            </div>
          )}
          {section === 'logs' && selectedSlug && (
            <AppLogs projectId={projectId} slug={selectedSlug} onClose={() => setSection('list')} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
