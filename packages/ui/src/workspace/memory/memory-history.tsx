'use client';

import type { ProjectMemoryPage, ProjectMemoryVersion } from '@kortix/sdk';
import { useProjectMemoryHistory, useUpdateProjectMemoryPage } from '@kortix/sdk/react';
import { diffLines } from 'diff';
import { useMemo, type MouseEvent } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { hasOpenFloatingLayer } from '../../lib/z-stack';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import Loading from '../../primitives/loading';
import {
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetTitle,
} from '../../primitives/split-sheet';
import { errorToast, successToast } from '../../primitives/toast';
import { hasMemoryAuthor, MemoryAuthorAvatar, useMemoryAuthorName } from './memory-labels';

/** The row's quiet bordered buttons, as the reader's Edit · History · Delete. */
const ACTION = 'text-muted-foreground hover:text-foreground font-normal';

/** A version as one text, so a title or summary change counts with the body. */
function versionText(version: ProjectMemoryVersion | undefined): string {
  if (!version) return '';
  const { title, summary, body } = version.snapshot;
  return `${[`# ${title}`, summary, body].filter(Boolean).join('\n\n')}\n`;
}

/** Lines a version added and removed against the one before it. */
function lineChanges(version: ProjectMemoryVersion, previous: ProjectMemoryVersion | undefined) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(versionText(previous), versionText(version))) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/**
 * The sheet covers the reader: the split sheet's container is too narrow for
 * two columns (`@max-3xl/split-sheet`), so its main cell is `invisible`. A
 * preview shown behind the sheet would then show nothing.
 */
function coversReader(from: HTMLElement): boolean {
  const main = from
    .closest('[data-slot="split-sheet-grid"]')
    ?.querySelector<HTMLElement>(':scope > [data-slot="split-sheet-main"]');
  return !!main && getComputedStyle(main).visibility === 'hidden';
}

/** The versions History shows; the reader reads the same cache for the one it previews. */
export function useMemoryVersions(projectId: string, pageId: string | undefined) {
  const history = useProjectMemoryHistory(projectId, pageId);
  return { history, versions: history.data?.versions ?? [] };
}

/** "Restore this version": the version's body comes back as a new edit (the title is the file's and does not change). */
export function useRestoreMemoryVersion(projectId: string, page: ProjectMemoryPage, onRestored: () => void) {
  const t = useTranslations('spaces.memory');
  const update = useUpdateProjectMemoryPage(projectId);
  const restore = (version: ProjectMemoryVersion) =>
    update.mutate(
      { pageId: page.page_id, input: { base_version: page.version_no, body: version.snapshot.body } },
      {
        onSuccess: () => {
          successToast(t('history.restored'));
          onRestored();
        },
        onError: () => errorToast(t('history.restoreFailed')),
      },
    );
  return { restore, restoring: update.isPending };
}

/**
 * The page's History in a sheet beside the reader: every version, newest
 * first. Preview shows a version in the reader, as the page looked then;
 * Restore makes it the current version. `previewId` is the previewed
 * version (null: the current page). Esc while previewing returns to the
 * current page; a second Esc closes the sheet. Where the sheet covers the
 * reader (a narrow container), Preview passes `covered`: the view closes the
 * sheet so the reader can show the version.
 */
export function MemoryHistory({
  projectId,
  page,
  previewId,
  onPreview,
  onRestored,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  previewId: string | null;
  onPreview: (versionId: string | null, covered?: boolean) => void;
  onRestored: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const { history, versions } = useMemoryVersions(projectId, page.page_id);
  const { restore, restoring } = useRestoreMemoryVersion(projectId, page, onRestored);

  return (
    <SplitSheetContent
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !previewId || hasOpenFloatingLayer()) return;
        // Handled here, so the sheet stays open.
        event.preventDefault();
        onPreview(null);
      }}
    >
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
        ) : !history.data ? (
          <div className="flex justify-center py-8">
            <Loading className="size-4 shrink-0" />
          </div>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {versions.map((version, index) => (
              <VersionRow
                key={version.version_id}
                version={version}
                previous={versions[index + 1]}
                current={index === 0}
                previewed={version.version_id === previewId}
                canRestore={page.can_edit && index > 0 && !version.snapshot.deleted}
                restoring={restoring}
                onPreview={(event) => {
                  // Covered: Preview always shows the version (the reader is hidden, so a second press is not "back").
                  const covered = coversReader(event.currentTarget);
                  const toggleOff = !covered && version.version_id === previewId;
                  onPreview(toggleOff ? null : version.version_id, covered);
                }}
                onRestore={() => restore(version)}
              />
            ))}
          </ol>
        )}
      </SplitSheetBody>
    </SplitSheetContent>
  );
}

function VersionRow({
  version,
  previous,
  current,
  previewed,
  canRestore,
  restoring,
  onPreview,
  onRestore,
}: {
  version: ProjectMemoryVersion;
  /** The version before it; undefined for the first version (or one past the loaded history). */
  previous: ProjectMemoryVersion | undefined;
  current: boolean;
  previewed: boolean;
  canRestore: boolean;
  restoring: boolean;
  onPreview: (event: MouseEvent<HTMLButtonElement>) => void;
  onRestore: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  const name = authorName(version.author);
  const changes = useMemo(() => lineChanges(version, previous), [version, previous]);
  const meta = [
    relativeTime(version.created_at, locale),
    changes.added ? t('history.added', { count: changes.added }) : null,
    changes.removed ? t('history.removed', { count: changes.removed }) : null,
  ].filter(Boolean);
  const canPreview = !current && !version.snapshot.deleted;
  return (
    <li
      aria-current={previewed || undefined}
      className={cn('flex items-start gap-2.5 rounded-md px-2.5 py-2', previewed && 'bg-active')}
    >
      <MemoryAuthorAvatar author={version.author} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="truncate font-medium">
            {hasMemoryAuthor(version.author)
              ? t(`history.op.${version.op}`, { author: name })
              : t(version.op === 'create' ? 'history.created' : 'history.edited')}
          </span>
          {current ? <Badge variant="muted">{t('history.current')}</Badge> : null}
        </span>
        <span className="text-muted-foreground truncate text-xs tabular-nums">{meta.join(' · ')}</span>
        {canPreview || canRestore ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
            {canPreview ? (
              <Button variant="outline" size="toolbar" className={ACTION} aria-pressed={previewed} onClick={onPreview}>
                {t('history.preview')}
              </Button>
            ) : null}
            {canRestore ? (
              <Button
                variant="outline"
                size="toolbar"
                className={ACTION}
                disabled={restoring}
                aria-busy={restoring || undefined}
                onClick={onRestore}
              >
                {t('history.restoreShort')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
