'use client';

import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SessionChat } from '@/features/session/session-chat';
import { cn } from '@/lib/utils';
import { KanbanIcon as SquareKanban, XIcon as X } from '@phosphor-icons/react';

interface SubSessionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  title?: string;
}

export function SubSessionModal({ open, onOpenChange, sessionId, title }: SubSessionModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        showCloseButton={false}
        className={cn(
          'flex flex-col gap-0 space-y-0 overflow-hidden p-0',
          // lg:max-w-* is required — the base modal sets lg:max-w-lg, which
          // tailwind-merge won't strip for an unprefixed max-w-* override.
          'h-[80vh] max-h-[840px] lg:h-[80vh] lg:max-w-6xl',
        )}
        aria-describedby={undefined}
      >
        {/* Header bar */}
        <div className="border-border/50 bg-muted/30 flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
          <SquareKanban className="text-muted-foreground size-3.5 shrink-0" />
          <ModalTitle className="flex-1 truncate text-sm font-medium">
            {title || 'Sub-session'}
          </ModalTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close sub-session"
            className={cn(
              // size-6 visible, 40px hit area — the header is dense, so the
              // target is grown with a pseudo-element instead of the box.
              'hit-area-2 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md',
              'text-muted-foreground hover:text-foreground',
              'hover:bg-muted/60 transition-colors',
            )}
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Session chat — read-only, no header */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionChat sessionId={sessionId} hideHeader readOnly initialScrollTop />
        </div>
      </ModalContent>
    </Modal>
  );
}
