'use client';

/**
 * The floating select-mode bar shared by every multi-select list: the count,
 * then one `secondary` ButtonGroup (Select all, then the caller's actions),
 * then the exit button. A destructive action keeps the group's variant and
 * takes the destructive text tone. While a bulk action runs, the count line
 * reads its progress with the session dot matrix and every control disables.
 *
 * It enters with a short rise and fade (reduced motion keeps the fade only).
 * It leaves at once: Esc exits select mode, and a keyboard action never
 * animates. `animateIn={false}` skips the enter too, for a keyboard-opened bar.
 */

import { CheckSquareIcon, XIcon } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import Hint from '../../primitives/hint';

export interface SelectionBarAction {
  id: string;
  label: string;
  /** A `size-3.5 shrink-0` glyph. */
  icon: ReactNode;
  tone?: 'default' | 'destructive';
  disabled?: boolean;
  onSelect: () => void;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
// A full transform string, not `y`: it runs on the compositor while the list loads.
const RISE = 'translateY(8px)';
const REST = 'translateY(0px)';

export function SelectionBar({
  selectedCount,
  allSelected,
  canSelectAll = true,
  onSelectAll,
  onClear,
  onExit,
  actions,
  progress = null,
  animateIn = true,
}: {
  selectedCount: number;
  allSelected: boolean;
  /** False when the list shows nothing to select. */
  canSelectAll?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onExit: () => void;
  actions: readonly SelectionBarAction[];
  /**
   * A running bulk action: `label` is the full progress line ("Pausing 3 of 12…").
   * `done` and `total` ride along for consumers that render their own label.
   */
  progress?: { label: string; done: number; total: number } | null;
  /** False skips the enter animation (select mode opened from the keyboard). */
  animateIn?: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const reduceMotion = useReducedMotion();
  const busy = progress !== null;
  const selectLabel = allSelected ? t.raw('text83b12c2216ef') : t.raw('text1fc9a387654d');
  // One action: a fixed-height button whose label hides when the bar is
  // narrow (`@xl/bar`), leaving the icon with its name as aria-label and Hint.
  const action = (a: SelectionBarAction) => (
    <Hint key={a.id} label={a.label} side="top">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={a.label}
        onClick={a.onSelect}
        disabled={busy || a.disabled}
        className={cn(
          'h-8 shrink-0 gap-1.5',
          a.tone === 'destructive' && 'text-destructive hover:text-destructive',
        )}
      >
        {a.icon}
        <span className="hidden @xl/bar:inline">{a.label}</span>
      </Button>
    </Hint>
  );
  return (
    <m.div
      initial={animateIn ? { opacity: 0, transform: reduceMotion ? REST : RISE } : false}
      animate={{
        opacity: 1,
        transform: REST,
        transition: { duration: 0.18, ease: EASE_OUT },
      }}
      className="bg-popover text-popover-foreground border-border @container/bar flex w-full items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md"
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium tabular-nums"
        aria-live="polite"
      >
        {progress ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
        <span className="truncate">
          {progress ? progress.label : t('text1cc5b0d9628f', { count: selectedCount })}
        </span>
      </span>
      <ButtonGroup className="shrink-0">
        {action({
          id: 'select-all',
          label: selectLabel,
          icon: <CheckSquareIcon className="size-3.5 shrink-0" />,
          disabled: !canSelectAll,
          onSelect: allSelected ? onClear : onSelectAll,
        })}
        {actions.map(action)}
      </ButtonGroup>
      <Hint label={t.raw('text22206bc67806')} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t.raw('text22206bc67806')}
          onClick={onExit}
          disabled={busy}
          className="size-8 shrink-0"
        >
          <XIcon className="size-4 shrink-0" />
        </Button>
      </Hint>
    </m.div>
  );
}
