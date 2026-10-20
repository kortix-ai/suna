'use client';

/**
 * The Triggers select-mode bar: the shared `SelectionBar` with Pause, Resume
 * and (for members who may delete) Delete. Delete is the destructive tone.
 * While a bulk action runs, the count line reads its progress.
 */

import { PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { SelectionBar, type SelectionBarAction } from '../../../workspace/selection/selection-bar';

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
  const actions: SelectionBarAction[] = [
    {
      id: 'pause',
      label: t.raw('text858e4ba7a29f'),
      icon: <PauseIcon className="size-3.5 shrink-0" />,
      disabled: !canPause,
      onSelect: onPause,
    },
    {
      id: 'resume',
      label: t.raw('textd640c7421da0'),
      icon: <PlayIcon className="size-3.5 shrink-0" />,
      disabled: !canResume,
      onSelect: onResume,
    },
  ];
  if (canDelete) {
    actions.push({
      id: 'delete',
      label: t.raw('texte2d0a54968ea'),
      icon: <TrashIcon className="size-3.5 shrink-0" />,
      tone: 'destructive',
      disabled: selectedCount === 0,
      onSelect: onDelete,
    });
  }
  return (
    <SelectionBar
      selectedCount={selectedCount}
      allSelected={allSelected}
      canSelectAll={shownCount > 0}
      onSelectAll={onSelectAll}
      onClear={onClear}
      onExit={onExit}
      actions={actions}
      progress={
        progress && {
          ...progress,
          label: t(PROGRESS_KEY[progress.verb], {
            done: progress.done,
            total: progress.total,
          }),
        }
      }
    />
  );
}
