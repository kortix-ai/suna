'use client';

import { useTranslations } from 'next-intl';

import { useCallback } from 'react';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSummarizeOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';

interface CompactDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CompactDialog({ sessionId, open, onOpenChange }: CompactDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const summarize = useSummarizeOpenCodeSession();

  const handleCompact = useCallback(() => {
    // Close the dialog immediately — compaction runs in the background
    onOpenChange(false);
    toast.info('Compacting session...');

    summarize.mutate({ sessionId }, {
      onSuccess: () => {
        toast.success('Session compacted successfully');
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : 'Failed to compact session');
      },
    });
  }, [sessionId, summarize, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />{tHardcodedUi.raw('componentsSessionCompactDialog.line47JsxTextCompactSession')}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">{tHardcodedUi.raw('componentsSessionCompactDialog.line50JsxTextThisWillSummarizeOlderMessagesUsingAiTo')}</DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl bg-muted/50 border border-border/40 px-3 py-2.5 text-xs text-muted-foreground space-y-1.5">
          <p>{tHardcodedUi.raw('componentsSessionCompactDialog.line56JsxTextWhatHappensDuringCompaction')}</p>
          <ul className="list-disc list-inside space-y-0.5 pl-1">
            <li>{tHardcodedUi.raw('componentsSessionCompactDialog.line58JsxTextOlderMessagesAreSummarizedIntoAConciseRecap')}</li>
            <li>{tHardcodedUi.raw('componentsSessionCompactDialog.line59JsxTextToolOutputsAndFileChangesArePreservedAs')}</li>
            <li>{tHardcodedUi.raw('componentsSessionCompactDialog.line60JsxTextRecentMessagesRemainUnchanged')}</li>
          </ul>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleCompact}>
            <Layers className="mr-2 h-3.5 w-3.5" />
            Compact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
