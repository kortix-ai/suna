'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { TrashIcon, XIcon } from '@phosphor-icons/react';

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
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium tabular-nums" aria-live="polite">
        {selectedCount} selected
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
          {allSelected ? 'Clear' : `Select all`}
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
            Delete {selectedCount}
          </Button>
        )}

        <Hint label="Exit selection" side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Exit selection"
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
