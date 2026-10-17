'use client';

/**
 * The Triggers select-mode bar. Its composition copies
 * `SessionsSelectionBar` (`features/workspace/project-sessions`): the count,
 * then the actions at `h-8`, then the exit button. It floats at the bottom
 * centre of the list column. The actions are one `outline` group; Delete is
 * the destructive tone inside it. While a bulk action runs, the count line
 * reads its progress with the session dot matrix.
 */

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';
import { PauseIcon, PlayIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

export type BulkVerb = 'pause' | 'resume' | 'delete';

const PROGRESS_KEY = {
  pause: 'text6363885af551',
  resume: 'text4cc2a4d3a49a',
  delete: 'text6e24bb562ab0',
} as const satisfies Record<BulkVerb, string>;

export function TriggerSelectionBar({
  selectedCount,
  shownCount,
  allSelected,
  canPause,
  canResume,
  canDelete,
  progress,
  onSelectAll,
  onClear,
  onPause,
  onResume,
  onDelete,
  onExit,
}: {
  selectedCount: number;
  /** Triggers the current filter and search show. */
  shownCount: number;
  allSelected: boolean;
  /** False when Pause would change nothing (no selected trigger is active). */
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
  progress: { verb: BulkVerb; done: number; total: number } | null;
  onSelectAll: () => void;
  onClear: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const busy = progress !== null;
  return (
    <div className="bg-popover text-popover-foreground border-border flex items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md">
      <span
        className="flex min-w-0 items-center gap-2 text-sm font-medium tabular-nums"
        aria-live="polite"
      >
        {progress ? (
          <>
            <SessionDotMatrix size={14} className="shrink-0" />
            {t(PROGRESS_KEY[progress.verb], { done: progress.done, total: progress.total })}
          </>
        ) : (
          t('text1cc5b0d9628f', { count: selectedCount })
        )}
      </span>
      <ButtonGroup className="ml-auto">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={allSelected ? onClear : onSelectAll}
          disabled={busy || shownCount === 0}
        >
          {allSelected ? t.raw('text83b12c2216ef') : t.raw('text1fc9a387654d')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={onPause}
          disabled={busy || !canPause}
        >
          <PauseIcon className="size-3.5 shrink-0" />
          {t.raw('text858e4ba7a29f')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={onResume}
          disabled={busy || !canResume}
        >
          <PlayIcon className="size-3.5 shrink-0" />
          {t.raw('textd640c7421da0')}
        </Button>
        {canDelete ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive h-8 gap-1.5"
            onClick={onDelete}
            disabled={busy || selectedCount === 0}
          >
            <TrashIcon className="size-3.5 shrink-0" />
            {t.raw('texte2d0a54968ea')}
          </Button>
        ) : null}
      </ButtonGroup>
      <Hint label={t.raw('text22206bc67806')} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t.raw('text22206bc67806')}
          onClick={onExit}
          disabled={busy}
          className="size-8"
        >
          <XIcon className="size-4 shrink-0" />
        </Button>
      </Hint>
    </div>
  );
}
