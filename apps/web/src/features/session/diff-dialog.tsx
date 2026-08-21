'use client';

import { useTranslations } from 'next-intl';

import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SessionDiffViewer } from '@/features/session/session-diff-viewer';
import { cn } from '@/lib/utils';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useState } from 'react';

interface DiffDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiffDialog({ sessionId, open, onOpenChange }: DiffDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) setIsFullscreen(false);
        onOpenChange(v);
      }}
    >
      <ModalContent
        className={cn(
          // `space-y-0`: ModalContent ships `space-y-4` for stacked
          // header/body/footer slots. This modal is a single full-bleed pane.
          'flex flex-col gap-0 space-y-0 overflow-hidden transition-[max-width] duration-200',
          isFullscreen
            ? 'h-[calc(100vh-2rem)] lg:max-h-[calc(100vh-2rem)] lg:max-w-[calc(100vw-2rem)]'
            : 'h-[80vh] lg:max-h-[80vh] lg:max-w-4xl',
        )}
      >
        <VisuallyHidden>
          <ModalTitle>
            {tHardcodedUi.raw('componentsSessionDiffDialog.line32JsxTextFileChanges')}
          </ModalTitle>
        </VisuallyHidden>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionDiffViewer
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen((v) => !v)}
            // Only this mount sits under ModalContent's floating close button.
            reserveCloseGutter
          />
        </div>
      </ModalContent>
    </Modal>
  );
}
