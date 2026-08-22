import Loading from '@/components/ui/loading';
import {
  RELOAD_PROGRESS_STEPS,
  reloadProgressPosition,
} from '@/hooks/projects/session-reload-progress';
import type { SessionReloadPhase } from '@kortix/sdk';
import { CheckIcon } from '@phosphor-icons/react';

export function SessionReloadProgressView({ phase }: { phase: SessionReloadPhase | null }) {
  return (
    <div className="mt-3 space-y-2" aria-live="polite" aria-atomic="true">
      {RELOAD_PROGRESS_STEPS.map((step) => {
        const position = reloadProgressPosition(phase, step.phase, false);
        return (
          <div
            key={step.phase}
            className="flex min-h-5 items-center gap-2 text-xs"
            data-state={position}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {position === 'complete' ? (
                <CheckIcon className="text-kortix-green size-3.5" weight="bold" />
              ) : position === 'current' ? (
                <Loading className="text-foreground size-3.5" />
              ) : (
                <span className="bg-border size-1.5 rounded-full" />
              )}
            </span>
            <span
              className={
                position === 'current' ? 'text-foreground font-medium' : 'text-muted-foreground'
              }
            >
              {step.label}
              {position === 'skipped' ? ' · Skipped' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
