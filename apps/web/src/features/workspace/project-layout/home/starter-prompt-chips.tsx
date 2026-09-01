'use client';

import { Button } from '@/components/ui/button';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';

/**
 * Starter prompt suggestions rendered as a centered, wrapping row of quiet
 * pills directly under the composer (Perplexity-style). All prompts are
 * visible at once — no scroll machinery; small screens show the first four.
 *
 * Deliberately NOT animated. These are part of the hero's first paint on every
 * single project open, and a stagger the user sits through that often is a
 * delay billed to them for no information gained.
 */
export function StarterPromptChips({
  onPick,
  className,
}: {
  onPick: (text: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
      {STARTER_PROMPTS.map((p, i) => {
        const ChipIcon = p.icon;
        const chalk = chalkColors(p.label);
        return (
          <Button
            key={p.id}
            onClick={() => onPick(p.prompt)}
            variant="outline"
            size="sm"
            className={cn(
              'bg-background/60 shrink-0 gap-1.5 rounded-md backdrop-blur-sm',
              i >= 4 && 'max-sm:hidden',
            )}
          >
            <ChipIcon
              className="size-3.5 shrink-0"
              style={{ color: chalk.foreground }}
              aria-hidden
            />
            {p.label}
          </Button>
        );
      })}
    </div>
  );
}
