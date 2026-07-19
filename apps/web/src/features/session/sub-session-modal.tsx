'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'h-[80vh] max-h-[840px] w-[92vw] max-w-5xl',
        )}
        aria-describedby={undefined}
      >
        {/* Header bar */}
        <div className="border-border/50 bg-muted/30 flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
          <SquareKanban className="text-muted-foreground size-3.5 flex-shrink-0" />
          <DialogTitle className="flex-1 truncate text-sm font-medium">
            {title || 'Sub-session'}
          </DialogTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={cn(
              'flex size-6 items-center justify-center rounded-md',
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
      </DialogContent>
    </Dialog>
  );
}
