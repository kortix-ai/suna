'use client';

import { ApiError, type ProjectMemoryPageSummary, type ProjectMemoryUndoResult } from '@kortix/sdk';
import { useProjectMemoryHistory, useUndoProjectMemoryVersion } from '@kortix/sdk/react';
import { useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { Button } from '../../primitives/button';
import { errorToast, successToast } from '../../primitives/toast';
import { addedLine } from './body-tokens';
import { useMemoryAuthorName } from './memory-labels';

/** A change an agent made this recently shows above the page. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * Undo one change by any of its versions, with the toasts every Undo shares.
 * `onUndone` gets the pages the undo left live (empty when it removed a page
 * it had created).
 */
export function useUndoMemoryChange(projectId: string) {
  const t = useTranslations('spaces.memory');
  const undo = useUndoProjectMemoryVersion(projectId);
  const run = (versionId: string, onUndone?: (result: ProjectMemoryUndoResult) => void) =>
    undo.mutate(versionId, {
      onSuccess: (result) => {
        successToast(t('undone'));
        onUndone?.(result);
      },
      onError: (err) => {
        const code = err instanceof ApiError ? err.code : null;
        errorToast(code === 'superseded' ? t('superseded') : code === 'already_undone' ? t('alreadyUndone') : t('undoFailed'));
      },
    });
  return { run, isPending: undo.isPending };
}

/**
 * "Writer updated this page 2 h ago: added “…” · View change · Undo": the
 * page's newest version, while it is an agent's and at most 24 hours old.
 */
export function MemoryRecentChange({
  projectId,
  page,
  onViewChange,
  onRemoved,
}: {
  projectId: string;
  page: ProjectMemoryPageSummary;
  onViewChange: (versionId: string) => void;
  /** The undo removed the page (it undid the page's creation). */
  onRemoved: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  // Read once per mount: the strip does not vanish while someone reads it.
  const [now] = useState(Date.now);
  const recent = page.updated_by.kind === 'agent' && now - Date.parse(page.updated_at) <= RECENT_MS;
  const history = useProjectMemoryHistory(projectId, page.page_id, { enabled: recent });
  const undo = useUndoMemoryChange(projectId);
  const versions = history.data?.pages[0]?.versions ?? [];
  const [latest, previous] = versions;
  if (!recent || !latest || latest.undone || latest.author.kind !== 'agent') return null;

  const values = { author: authorName(latest.author), time: relativeTime(latest.created_at, locale) };
  const fact = latest.op === 'create' ? null : addedLine(previous?.snapshot.body ?? '', latest.snapshot.body);
  const text =
    latest.op === 'create'
      ? t('recent.created', values)
      : fact
        ? t('recent.added', { ...values, fact })
        : t('recent.updated', values);

  return (
    <div className="bg-card flex min-h-9 max-w-3xl shrink-0 items-center gap-2.5 rounded-md py-1 pr-1.5 pl-3">
      <span aria-hidden className="bg-kortix-blue size-1.5 shrink-0 rounded-full" />
      <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={text}>
        {text}
      </p>
      <Button variant="ghost" size="toolbar" className="text-muted-foreground" onClick={() => onViewChange(latest.version_id)}>
        {t('recent.viewChange')}
      </Button>
      {latest.can_undo ? (
        <Button
          variant="ghost"
          size="toolbar"
          disabled={undo.isPending}
          aria-busy={undo.isPending || undefined}
          onClick={() =>
            undo.run(latest.version_id, (result) => {
              if (!result.pages.some((p) => p.page_id === page.page_id)) onRemoved();
            })
          }
        >
          {t('undo')}
        </Button>
      ) : null}
    </div>
  );
}
