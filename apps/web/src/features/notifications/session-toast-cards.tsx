'use client';

import { Button } from '@/components/ui/button';
import { ToastClose, toastIcon } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * The session notification cards drawn on the toast surface: a failed turn
 * (error glyph + error preview + Open) and the stack several finished turns
 * collapse into. A single finished turn uses the plain `ToastCard` with an
 * entity row. Board: Paper "Toasts · Linear-style system + task-complete
 * notification", artboard 02.
 */

const CARD = 'bg-background text-foreground smooth-shadow-ring-sm rounded-xl';

export function SessionFailedCard({
  label,
  meta,
  preview,
  openLabel,
  onOpen,
  onDismiss,
}: {
  label: string;
  meta: string;
  preview?: string;
  openLabel: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={cn(CARD, 'flex w-full flex-col gap-2.5 py-4 pr-3 pl-4 sm:w-[var(--width)]')}>
      <div className="flex items-start gap-2.5">
        <div className="flex h-5 w-4 shrink-0 items-center justify-center">{toastIcon('error')}</div>
        <div className="flex min-w-0 grow flex-col">
          <p className="truncate text-xs leading-5 font-medium">{label}</p>
          <p className="text-muted-foreground text-xs leading-4">{meta}</p>
        </div>
        <ToastClose onDismiss={onDismiss} />
      </div>
      {preview && (
        <p className="text-muted-foreground line-clamp-2 pr-1.5 pl-6.5 text-xs leading-5">
          {preview}
        </p>
      )}
      <div className="flex items-center gap-1.5 pl-6.5">
        <Button
          size="xs"
          onClick={() => {
            onDismiss();
            onOpen();
          }}
        >
          {openLabel}
        </Button>
      </div>
    </div>
  );
}

export type SessionStackItem = {
  sessionId: string;
  label: string;
  failed: boolean;
  at: number;
};

/** Minutes since `at`, as "2m"; nothing under a minute. */
const shortAgo = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000);
  return minutes >= 1 ? `${minutes}m` : '';
};

export function SessionStackCard({
  title,
  items,
  openLabel,
  onOpen,
  onDismiss,
}: {
  title: string;
  items: SessionStackItem[];
  openLabel: string;
  onOpen: (sessionId: string) => void;
  onDismiss: () => void;
}) {
  // eslint-disable-next-line react-hooks/purity -- a relative label, read once per render
  const now = Date.now();
  return (
    <div className={cn(CARD, 'flex w-full flex-col p-1.5 sm:w-[var(--width)]')}>
      <div className="flex items-center gap-2 pt-1.5 pr-1 pb-2 pl-2">
        <p className="grow text-xs leading-5 font-medium">{title}</p>
        <ToastClose onDismiss={onDismiss} />
      </div>
      {items.map((item) => (
        <button
          key={item.sessionId}
          type="button"
          onClick={() => {
            onDismiss();
            onOpen(item.sessionId);
          }}
          className="group hover:bg-foreground/5 flex items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors"
        >
          <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
            {toastIcon(item.failed ? 'error' : 'success')}
          </span>
          <span className="min-w-0 grow truncate text-xs leading-5">{item.label}</span>
          <span className="text-muted-foreground shrink-0 text-xs leading-4 group-hover:hidden">
            {shortAgo(item.at, now)}
          </span>
          <span className="text-muted-foreground hidden shrink-0 text-xs leading-4 group-hover:inline">
            {openLabel}
          </span>
        </button>
      ))}
    </div>
  );
}
