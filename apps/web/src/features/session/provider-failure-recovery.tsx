'use client';

import {
  ArrowCounterClockwiseIcon,
  CopyIcon,
  TrashIcon,
} from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import type { PendingSessionPrompt } from '@kortix/sdk';

interface ProviderFailureRecoveryProps {
  pendingPrompt: PendingSessionPrompt | null;
  isRetrying: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

/** One recovery surface for every terminal sandbox-provider failure. */
export function ProviderFailureRecovery({
  pendingPrompt,
  isRetrying,
  onRetry,
  onCopy,
  onDelete,
}: ProviderFailureRecoveryProps) {
  const attachmentNames = pendingPrompt?.attachment_names ?? [];

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      {pendingPrompt ? (
        <div className="border-border/60 bg-muted/40 w-full rounded-md border px-3 py-2.5 text-left">
          <p className="text-muted-foreground mb-1 text-xs font-medium">Saved prompt</p>
          {pendingPrompt.text ? (
            <p className="text-foreground/90 max-h-40 overflow-y-auto whitespace-pre-wrap wrap-break-word text-xs leading-relaxed">
              {pendingPrompt.text}
            </p>
          ) : (
            <p className="text-muted-foreground/70 text-xs">No text prompt was attached.</p>
          )}
          {attachmentNames.length > 0 ? (
            <div className="border-border/60 mt-2 border-t pt-2">
              <p className="text-muted-foreground mb-1 text-xs font-medium">
                {attachmentNames.length === 1 ? 'Attachment' : 'Attachments'}
              </p>
              <ul className="text-muted-foreground/70 space-y-0.5 text-xs">
                {attachmentNames.map((name, index) => (
                  <li key={`${name}-${index}`} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground/70 mt-1 text-xs">
                Reattach these files after a reload.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No saved prompt is available.</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={isRetrying}
          aria-busy={isRetrying}
        >
          {isRetrying ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
          )}
          {isRetrying ? 'Retrying…' : 'Retry'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCopy}
          disabled={!pendingPrompt?.text}
        >
          <CopyIcon className="size-3.5 shrink-0" />
          Copy prompt
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
          <TrashIcon className="size-3.5 shrink-0" />
          Delete
        </Button>
      </div>
    </div>
  );
}
