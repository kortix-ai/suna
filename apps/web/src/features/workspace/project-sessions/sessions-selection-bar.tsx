'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { TrashIcon, XIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function SessionsSelectionBar({
  selectedCount,
  selectableCount,
  allSelected,
  onSelectAll,
  onClearSelection,
  onExit,
  onDelete,
  deleting,
}: {
  selectedCount: number;
  /** Deletable sessions in the CURRENT filtered view, not the whole project. */
  selectableCount: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onExit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium tabular-nums" aria-live="polite">
        {selectedCount} {tI18nComplete.raw('textd7cbbb688b2e')}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={allSelected ? onClearSelection : onSelectAll}
          disabled={deleting || selectableCount === 0}
          className="h-8 transition-[scale] duration-150 active:scale-[0.96]"
        >
          {allSelected ? 'Clear' : tI18nComplete.raw('text1fc9a387654d')}
        </Button>

        {selectedCount > 0 && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onDelete}
            disabled={deleting || selectedCount === 0}
            aria-busy={deleting}
            className="h-8 gap-1.5 transition-[scale] duration-150 active:scale-[0.96]"
          >
            {deleting ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <TrashIcon className="size-3.5 shrink-0" />
            )}
            {tI18nComplete.raw('texte2d0a54968ea')} {selectedCount > 0 ? selectedCount : ''}
          </Button>
        )}

        <Hint label={tI18nComplete.raw('text22206bc67806')} side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={tI18nComplete.raw('text22206bc67806')}
            onClick={onExit}
            disabled={deleting}
            className="size-8 transition-[scale] duration-150 active:scale-[0.96]"
          >
            <XIcon className="size-4 shrink-0" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}
