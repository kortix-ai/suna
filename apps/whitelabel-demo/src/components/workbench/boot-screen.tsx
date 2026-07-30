'use client';

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';

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
  return (
    <div className="grid flex-1 place-items-center px-6">
      {failed ? (
        <div className="text-center">
          <p className="text-sm text-destructive">{reason || 'The session could not start.'}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loading className="size-4" /> {label}
        </div>
      )}
    </div>
  );
}
