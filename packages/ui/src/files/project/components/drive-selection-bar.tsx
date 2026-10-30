'use client';

import { Button } from '../../../primitives/button';
import { ButtonGroup } from '../../../primitives/button-group';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { Download } from '../../../internal/icons/download';
import { useTranslations } from '../../../i18n';
import {
  ArrowsLeftRightIcon,
  CheckSquareIcon,
  ClipboardIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useSyncExternalStore } from 'react';

import type { SelectionStore } from './drive-selection';

/**
 * The multi-selection's actions, floating at the bottom centre of the listing
 * like the Triggers page's selection bar (`trigger-selection-bar.tsx`). Two
 * rows: the count and close on top, the actions below as one secondary group
 * across the full width, so every label fits. Labels drop to icons when narrow.
 */
export function DriveSelectionBar({
  store,
  total,
  zipping,
  canWrite,
  onSelectAll,
  onClearSelection,
  onDownload,
  onCopy,
  onMove,
  onDelete,
  onExit,
}: {
  /** Read here, so only the bar re-renders as the count moves. */
  store: SelectionStore;
  /** Items in view, for "Select all" vs "Deselect all". */
  total: number;
  zipping: boolean;
  canWrite: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onMove: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  const t = useTranslations('drives');
  const count = useSyncExternalStore(store.subscribe, () => store.paths().size, () => 0);
  const allSelected = total > 0 && count === total;
  const none = count === 0;
  const action = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Hint label={label} side="top">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="min-w-0 flex-1 gap-1.5 active:scale-[0.96]"
      >
        {icon}
        <span className="hidden truncate @md/bar:inline">{label}</span>
      </Button>
    </Hint>
  );

  return (
    <div className="bg-popover text-popover-foreground border-border @container/bar flex w-full flex-col gap-2 rounded-lg border p-2 shadow-md">
      <div className="flex items-center gap-2 pl-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums" aria-live="polite">
          {t('selectedCount', { count })}
        </span>
        <Hint label={t('cancel')} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onExit}
            aria-label={t('cancel')}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <XIcon className="size-4" />
          </Button>
        </Hint>
      </div>
      <ButtonGroup className="w-full">
        {action(
          allSelected ? t('deselectAll') : t('selectAll'),
          <CheckSquareIcon className="size-3.5 shrink-0" />,
          allSelected ? onClearSelection : onSelectAll,
        )}
        {action(
          t('download'),
          zipping ? <Loading className="size-3.5 shrink-0" /> : <Download className="size-3.5 shrink-0" />,
          onDownload,
          none || zipping,
        )}
        {canWrite
          ? action(t('copyItems'), <ClipboardIcon className="size-3.5 shrink-0" />, onCopy, none)
          : null}
        {canWrite
          ? action(t('moveItems'), <ArrowsLeftRightIcon className="size-3.5 shrink-0" />, onMove, none)
          : null}
        {canWrite
          ? action(t('delete'), <TrashIcon className="size-3.5 shrink-0" />, onDelete, none)
          : null}
      </ButtonGroup>
    </div>
  );
}
