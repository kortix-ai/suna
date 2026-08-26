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
import { errorToast } from '@/components/ui/toast';
import { useSummarizeRuntimeSession } from '@kortix/sdk/react';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

interface CompactDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired when the user confirms compaction (vs. dismissing the modal). Lets a
   *  caller distinguish a real action from a cancel/Esc. */
  onCompactStart?: () => void;
}

export function CompactModal({
  sessionId,
  open,
  onOpenChange,
  onCompactStart,
}: CompactDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const summarize = useSummarizeRuntimeSession();

  const handleCompact = useCallback(() => {
    onCompactStart?.();
    onOpenChange(false);

    // No loading/success toast: the transcript's own CompactionCard is the
    // progress surface (it mounts optimistically and streams the summary).
    // Only a failure still needs a voice — the card cannot say why the HTTP
    // call itself never reached the runtime.
    summarize.mutateAsync({ sessionId }).catch((error: unknown) => {
      errorToast(error instanceof Error ? error.message : 'Failed to compact session');
    });
  }, [sessionId, summarize, onOpenChange, onCompactStart]);

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
          <div className="text-muted-foreground space-y-1.5 text-sm">
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
        <ModalFooter>
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={handleCompact}>
            Compact
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
