'use client';

import { useTranslations } from 'next-intl';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { SessionDiffViewer } from '@/components/session/session-diff-viewer';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { cn } from '@/lib/utils';

interface DiffDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiffDialog({ sessionId, open, onOpenChange }: DiffDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setIsFullscreen(false); onOpenChange(v); }}>
      <DialogContent
        className={cn(
          'flex flex-col p-0 gap-0 overflow-hidden transition-colors duration-200',
          isFullscreen
            ? 'sm:max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] h-[calc(100vh-2rem)]'
            : 'sm:max-w-4xl max-h-[80vh]',
        )}
      >
        <VisuallyHidden><DialogTitle>{tHardcodedUi.raw('componentsSessionDiffDialog.line32JsxTextFileChanges')}</DialogTitle></VisuallyHidden>
        <div className="flex-1 min-h-0 overflow-hidden">
          <SessionDiffViewer
            sessionId={sessionId}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen((v) => !v)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
