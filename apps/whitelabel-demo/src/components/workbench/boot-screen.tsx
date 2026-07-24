'use client';

import { Button } from '@/components/ui/button';
import { humanizeBootReason } from '@/lib/boot-reasons';
import { Loader2, RotateCw, ServerCrash } from 'lucide-react';

export function BootScreen({
  stage,
  reason,
  failed,
  onRetry,
}: {
  stage?: string;
  reason?: string;
  failed?: boolean;
  onRetry: () => void;
}) {
  const label =
    stage === 'provisioning'
      ? 'Provisioning sandbox…'
      : stage === 'starting'
        ? 'Starting the runtime…'
        : 'Connecting…';

  if (failed) {
    const failure = humanizeBootReason(reason);
    return (
      <div className="grid flex-1 place-items-center px-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
            <ServerCrash className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-sm font-medium">{failure.title}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{failure.hint}</p>
          {failure.code && (
            <code className="mt-3 rounded-md bg-muted px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
              {failure.code}
            </code>
          )}
          <Button variant="outline" size="sm" className="mt-5 gap-1.5" onClick={onRetry}>
            <RotateCw className="size-3.5" /> Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid flex-1 place-items-center px-6">
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {label}
      </div>
    </div>
  );
}
