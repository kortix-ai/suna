'use client';

import { Button } from '@/components/ui/button';
import { errorToast } from '@/components/ui/toast';
import { useDismissDriveConflict, useDriveConflicts } from '@/hooks/drives/use-drives';
import { useFormatter, useNow, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CaretUpIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { parentDrivePath } from './drive-explorer-source';

const PANEL_WIDTH = 440;
const EASE = [0.22, 1, 0.36, 1] as const;

/** `/a/b/report (conflict …).txt` → name and the folder that holds it. */
function splitConflictPath(path: string): { name: string; folder: string } {
  const folder = parentDrivePath(path);
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return { name, folder };
}

/**
 * Conflict copies in the folders the caller can see: two writers changed the
 * same file at once and both versions were kept. A small pill floats at the
 * bottom of Files; hovering or activating it grows a panel upward listing
 * each copy, with "open folder" and "dismiss" (the copy stays; the API refuses
 * a dismiss without write access there). A click pins the panel open; leaving,
 * clicking away or Escape collapses it. Renders nothing without conflicts.
 *
 * Must be placed inside a `relative` container: it positions itself at the
 * bottom of it.
 */
export function DriveConflictsBar({
  driveId,
  onOpenFolder,
}: {
  driveId: string;
  onOpenFolder: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const conflicts = useDriveConflicts(driveId);
  const dismiss = useDismissDriveConflict();
  const reduceMotion = useReducedMotion();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    setPinned(false);
  }, []);

  const cancelLeave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };

  useEffect(() => cancelLeave, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const hadFocus = rootRef.current?.contains(document.activeElement);
      close();
      if (hadFocus) triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const list = conflicts.data ?? [];
  if (list.length === 0) return null;

  const transition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: EASE };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <m.div
        ref={rootRef}
        role="region"
        aria-label={t('conflictsTitle', { count: list.length })}
        initial={false}
        animate={{ width: open ? PANEL_WIDTH : 'auto', borderRadius: open ? 12 : 18 }}
        transition={transition}
        onMouseEnter={() => {
          cancelLeave();
          setOpen(true);
        }}
        onMouseLeave={() => {
          if (pinned) return;
          cancelLeave();
          leaveTimer.current = setTimeout(close, 160);
        }}
        onBlur={(event) => {
          if (!pinned && !rootRef.current?.contains(event.relatedTarget as Node | null)) close();
        }}
        className="bg-popover text-popover-foreground border-border pointer-events-auto flex max-w-full flex-col overflow-hidden border shadow-md"
      >
        <AnimatePresence initial={false}>
          {open ? (
            <m.div
              key="panel"
              id={panelId}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={transition}
              className="min-w-0"
            >
              <div className="px-3.5 pt-3 pb-2">
                <p className="text-sm font-medium">{t('conflictsTitle', { count: list.length })}</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('conflictsDescription')}</p>
              </div>
              <ul className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
                {list.map((conflict) => {
                  const { name, folder } = splitConflictPath(conflict.path);
                  return (
                    <li
                      key={conflict.conflictId}
                      className="group hover:bg-foreground/5 focus-within:bg-foreground/5 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1" title={conflict.path}>
                        <p className="truncate text-xs font-medium">{name}</p>
                        <p className="text-muted-foreground truncate text-[11px]">
                          {folder}
                          <span aria-hidden> · </span>
                          {format.relativeTime(new Date(conflict.detectedAt), now)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground text-xs"
                          onClick={() => onOpenFolder(parentDrivePath(conflict.path))}
                        >
                          {t('conflictOpenFolder')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground text-xs"
                          disabled={dismiss.isPending}
                          onClick={() =>
                            dismiss.mutate(
                              { driveId, conflictId: conflict.conflictId },
                              { onError: () => errorToast(t('conflictDismissFailed')) },
                            )
                          }
                        >
                          {t('conflictDismiss')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </m.div>
          ) : null}
        </AnimatePresence>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            cancelLeave();
            if (open && pinned) close();
            else {
              setOpen(true);
              setPinned(true);
            }
          }}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-kortix-base flex h-9 shrink-0 items-center gap-2 px-3.5 text-xs whitespace-nowrap outline-none focus-visible:ring-[0.6px] focus-visible:ring-inset',
            open && 'border-border border-t',
          )}
        >
          <span aria-hidden className="bg-kortix-orange size-1.5 shrink-0 rounded-full" />
          <span className="text-foreground font-medium tabular-nums">{t('conflictCount', { count: list.length })}</span>
          <CaretUpIcon
            aria-hidden
            className={cn('ml-auto size-3 transition-transform duration-300 motion-reduce:transition-none', open && 'rotate-180')}
          />
        </button>
      </m.div>
    </div>
  );
}
