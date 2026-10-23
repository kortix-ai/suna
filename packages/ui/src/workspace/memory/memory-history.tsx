'use client';

import { ApiError, type ProjectMemoryPage, type ProjectMemoryVersion } from '@kortix/sdk';
import { useProjectMemoryHistory, useRestoreProjectMemoryPage } from '@kortix/sdk/react';

import { DiffView } from '../../diff/diff-view';
import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import {
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetTitle,
} from '../../primitives/split-sheet';
import { errorToast, successToast } from '../../primitives/toast';
import { MemoryAuthorAvatar, useMemoryAuthorName } from './memory-labels';

/** A version as one text, so title and summary changes show in the same diff as the body. */
function versionText(version: ProjectMemoryVersion | undefined): string {
  if (!version) return '';
  const { title, summary, body } = version.snapshot;
  return `${[`# ${title}`, summary, body].filter(Boolean).join('\n\n')}\n`;
}

/**
 * The page's History in a sheet beside the reader: every version, newest
 * first. The selected version shows what it changed against the one before
 * it, and "Restore this version".
 */
export function MemoryHistory({
  projectId,
  page,
  selectedId,
  onSelect,
  onRestored,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  selectedId: string | null;
  onSelect: (versionId: string | null) => void;
  onRestored: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const history = useProjectMemoryHistory(projectId, page.page_id);
  const versions = history.data?.pages.flatMap((p) => p.versions) ?? [];
  const restore = useRestoreProjectMemoryPage(projectId);
  const selected = selectedId ?? versions[0]?.version_id ?? null;

  const restoreVersion = (version: ProjectMemoryVersion) =>
    restore.mutate(
      { pageId: page.page_id, versionId: version.version_id },
      {
        onSuccess: () => {
          successToast(t('history.restored'));
          onRestored();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : null;
          errorToast(
            code === 'page_limit'
              ? t('pageLimit')
              : code === 'title_taken'
                ? t('editor.error.titleTaken')
                : t('history.restoreFailed'),
          );
        },
      },
    );

  return (
    <SplitSheetContent>
      <SplitSheetHeader closeLabel={t('close')}>
        <SplitSheetTitle>{t('history.title')}</SplitSheetTitle>
        <SplitSheetDescription>{t('history.description', { title: page.title })}</SplitSheetDescription>
      </SplitSheetHeader>
      <SplitSheetBody className="px-2 py-2">
        {history.isError && !history.data ? (
          <ErrorState
            size="sm"
            title={t('history.loadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => history.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : (
          <ol className="flex flex-col gap-0.5">
            {versions.map((version, index) => (
              <VersionRow
                key={version.version_id}
                version={version}
                previous={versions[index + 1]}
                current={index === 0}
                selected={version.version_id === selected}
                canRestore={page.can_edit && index > 0 && !version.snapshot.deleted}
                restoring={restore.isPending}
                onSelect={() => onSelect(version.version_id)}
                onRestore={() => restoreVersion(version)}
              />
            ))}
          </ol>
        )}
        {history.hasNextPage ? (
          <Button
            variant="ghost"
            size="toolbar"
            className="text-muted-foreground mt-2"
            disabled={history.isFetchingNextPage}
            aria-busy={history.isFetchingNextPage || undefined}
            onClick={() => history.fetchNextPage()}
          >
            {t('loadOlder')}
          </Button>
        ) : null}
      </SplitSheetBody>
    </SplitSheetContent>
  );
}

function VersionRow({
  version,
  previous,
  current,
  selected,
  canRestore,
  restoring,
  onSelect,
  onRestore,
}: {
  version: ProjectMemoryVersion;
  /** The version before it; undefined for the first version (or one past the loaded history). */
  previous: ProjectMemoryVersion | undefined;
  current: boolean;
  selected: boolean;
  canRestore: boolean;
  restoring: boolean;
  onSelect: () => void;
  onRestore: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  const name = authorName(version.author);
  const meta = [
    version.source ? t('fromThread', { thread: version.source.label }) : null,
    relativeTime(version.created_at, locale),
  ].filter(Boolean);
  return (
    <li className={cn('rounded-md', selected && 'bg-active')}>
      <button
        type="button"
        aria-expanded={selected}
        onClick={onSelect}
        className={cn(
          'focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2',
          !selected && 'hover:bg-hover',
        )}
      >
        <MemoryAuthorAvatar author={version.author} name={name} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs">
            <span className="truncate font-medium">{t(`history.op.${version.op}`, { author: name })}</span>
            {current ? <Badge variant="muted">{t('history.current')}</Badge> : null}
            {version.undone ? <Badge variant="muted">{t('history.undone')}</Badge> : null}
          </span>
          <span className="text-muted-foreground truncate text-xs">{meta.join(' · ')}</span>
        </span>
      </button>
      {selected ? (
        <div className="flex flex-col gap-3 px-2.5 pb-3">
          <div className="overflow-hidden rounded-md border">
            <DiffView
              before={{ name: 'before.md', contents: versionText(previous) }}
              after={{ name: 'after.md', contents: versionText(version) }}
              layout="unified"
              hideFileHeader
              hideLineNumbers
              wrap
            />
          </div>
          {canRestore ? (
            <Button
              variant="outline"
              size="toolbar"
              className="self-start"
              disabled={restoring}
              aria-busy={restoring || undefined}
              onClick={onRestore}
            >
              {t('history.restore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
