'use client';

import { ApiError, listProjectMemoryHistory } from '@kortix/sdk';
import { useProjectMemoryPages, useRestoreProjectMemoryPage } from '@kortix/sdk/react';
import { CaretDownIcon, TrashIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import Loading from '../../primitives/loading';
import { errorToast, successToast } from '../../primitives/toast';

/**
 * "Trash" at the end of the page list, while the layer has deleted pages:
 * closed until opened (its list loads then), each page with Restore. A page
 * stays 30 days, then the server deletes it for good: there is no other way
 * to empty it.
 */
export function MemoryTrash({
  projectId,
  layerKey,
  count,
  canWrite,
  onRestored,
}: {
  projectId: string;
  layerKey: string;
  count: number;
  canWrite: boolean;
  onRestored: (pageId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  const [open, setOpen] = useState(false);
  const trash = useProjectMemoryPages(projectId, layerKey, { deleted: true, enabled: open });
  const restore = useRestoreProjectMemoryPage(projectId);
  const [restoring, setRestoring] = useState<string | null>(null);

  const run = async (pageId: string) => {
    setRestoring(pageId);
    try {
      // The page as it was before it went to the trash: its newest version that is not the delete.
      const { versions } = await listProjectMemoryHistory(projectId, pageId, { limit: 2 });
      const version = versions.find((v) => !v.snapshot.deleted) ?? versions[0];
      if (!version) throw new Error('no version');
      const page = await restore.mutateAsync({ pageId, versionId: version.version_id });
      successToast(t('trash.restored'));
      onRestored(page.page_id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      errorToast(code === 'page_limit' ? t('pageLimit') : code === 'title_taken' ? t('trash.titleTaken') : t('trash.restoreFailed'));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="flex flex-col gap-0.5 pt-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/type text-foreground hover:bg-hover focus-visible:ring-ring flex h-7.5 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-xs font-medium outline-none focus-visible:ring-2"
      >
        <span className="flex w-4 shrink-0 justify-center">
          <TrashIcon aria-hidden className="text-muted-foreground size-3.5 group-hover/type:hidden group-focus-visible/type:hidden" />
          <CaretDownIcon
            aria-hidden
            className={cn(
              'text-muted-foreground hidden size-3.5 group-hover/type:block group-focus-visible/type:block',
              !open && '-rotate-90',
            )}
          />
        </span>
        <span className="flex-1 truncate">{t('trash.title')}</span>
        <CountBadge count={count} />
      </button>
      {open ? (
        <>
          <p className="text-muted-foreground px-2 pb-1 pl-8.5 text-xs text-pretty">{t('trash.note')}</p>
          {trash.isError && !trash.data ? (
            <div className="flex items-center gap-2 pl-8.5">
              <p className="text-muted-foreground text-xs">{t('trash.loadError')}</p>
              <Button variant="ghost" size="toolbar" onClick={() => trash.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : !trash.data ? (
            <div className="flex justify-center py-3">
              <Loading className="size-4 shrink-0" />
            </div>
          ) : (
            trash.data.map((page) => (
              <div key={page.page_id} className="flex h-7.5 items-center gap-1 rounded-md pr-1 pl-8.5">
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={page.title}>
                  {page.title}
                </span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="toolbar"
                    className="text-muted-foreground h-6 shrink-0"
                    disabled={restoring !== null}
                    aria-busy={restoring === page.page_id || undefined}
                    aria-label={t('trash.restorePage', { title: page.title })}
                    onClick={() => void run(page.page_id)}
                  >
                    {restoring === page.page_id ? <Loading className="size-3.5 shrink-0" /> : null}
                    {t('trash.restore')}
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}
