import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { type SkeletonShape, pulseDelayMs } from './saved-session-skeleton-shape';

/**
 * One placeholder bar, on the pulse wave. The `Skeleton` primitive pads itself
 * (`py-4`); a bar sets its own height.
 */
export function SkeletonBar({
  phase,
  phases,
  className,
}: {
  phase: number;
  phases: number;
  className: string;
}) {
  return (
    <Skeleton
      className={cn('py-0 motion-reduce:animate-none', className)}
      style={{ animationDelay: `${pulseDelayMs(phase, phases)}ms` }}
    />
  );
}

/**
 * The placeholder turns of `SavedSessionSkeleton`: this session's own mix of
 * prompts and replies (`savedSessionSkeletonShape`). The rows appear together;
 * only the pulse moves, down the conversation.
 */
export function SavedSessionSkeletonRows({ shape }: { shape: SkeletonShape }) {
  const { phases } = shape;
  return (
    <>
      {shape.turns.map((turn) => (
        <div key={turn.prompt.phase} className="mt-12 first:mt-0">
          <div className="flex justify-end">
            <SkeletonBar
              phase={turn.prompt.phase}
              phases={phases}
              className={cn('rounded-lg', turn.prompt.tall ? 'h-16' : 'h-10', turn.prompt.width)}
            />
          </div>
          <div className="mt-5 space-y-4">
            {turn.tool ? (
              <div className="flex items-center gap-2">
                <SkeletonBar phase={turn.tool.phase} phases={phases} className="size-4 rounded-sm" />
                <SkeletonBar
                  phase={turn.tool.phase}
                  phases={phases}
                  className={cn('h-3.5', turn.tool.width)}
                />
              </div>
            ) : null}
            {turn.reply.map((paragraph) =>
              paragraph.kind === 'block' ? (
                <SkeletonBar
                  key={paragraph.phase}
                  phase={paragraph.phase}
                  phases={phases}
                  className="h-20 w-full"
                />
              ) : (
                <div key={paragraph.lines[0]?.phase} className="space-y-2.5">
                  {paragraph.lines.map((line) => (
                    <SkeletonBar
                      key={line.phase}
                      phase={line.phase}
                      phases={phases}
                      className={cn('h-3.5', line.width)}
                    />
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </>
  );
}
