'use client';

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
            <Layers className="h-4 w-4" />
            Compact Session
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            This will summarize older messages using AI to free up context space.
            Key information is preserved, but original messages will be condensed
            into a compact summary.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl bg-muted/50 border border-border/40 px-3 py-2.5 text-xs text-muted-foreground space-y-1.5">
          <p>What happens during compaction:</p>
          <ul className="list-disc list-inside space-y-0.5 pl-1">
            <li>Older messages are summarized into a concise recap</li>
            <li>Tool outputs and file changes are preserved as references</li>
            <li>Recent messages remain unchanged</li>
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
