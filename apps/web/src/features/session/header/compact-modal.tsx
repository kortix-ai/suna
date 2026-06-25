'use client';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { loadingToast } from '@/components/ui/toast';
import { useSummarizeOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { LayersThreeSolid as Layers } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

interface CompactDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CompactModal({ sessionId, open, onOpenChange }: CompactDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const summarize = useSummarizeOpenCodeSession();

  const handleCompact = useCallback(() => {
    onOpenChange(false);

    void loadingToast('Compacting session...', () => summarize.mutateAsync({ sessionId }), {
      success: 'Session compacted successfully',
      showErrorToast: true,
      error: (error) => (error instanceof Error ? error.message : 'Failed to compact session'),
    });
  }, [sessionId, summarize, onOpenChange]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tHardcodedUi.raw('componentsSessionCompactDialog.line47JsxTextCompactSession')}
          </ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsSessionCompactDialog.line50JsxTextThisWillSummarizeOlderMessagesUsingAiTo',
            )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <div className="bg-muted/50 border-border/40 text-muted-foreground space-y-1.5 rounded-2xl border px-3 py-2.5 text-sm">
            <p>
              {tHardcodedUi.raw(
                'componentsSessionCompactDialog.line56JsxTextWhatHappensDuringCompaction',
              )}
            </p>
            <ul className="list-inside list-disc space-y-0.5 pl-1">
              <li>
                {tHardcodedUi.raw(
                  'componentsSessionCompactDialog.line58JsxTextOlderMessagesAreSummarizedIntoAConciseRecap',
                )}
              </li>
              <li>
                {tHardcodedUi.raw(
                  'componentsSessionCompactDialog.line59JsxTextToolOutputsAndFileChangesArePreservedAs',
                )}
              </li>
              <li>
                {tHardcodedUi.raw(
                  'componentsSessionCompactDialog.line60JsxTextRecentMessagesRemainUnchanged',
                )}
              </li>
            </ul>
          </div>
        </ModalBody>
        <ModalFooter className="gap-2">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={handleCompact}>
            <Layers className="size-3.5" />
            Compact
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
