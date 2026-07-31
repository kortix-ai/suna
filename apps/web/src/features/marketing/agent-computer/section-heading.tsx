import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The one heading block every section on `/agent-computer` uses: eyebrow badge,
 * headline, sub. Repeating the same three elements at the same rhythm is what
 * makes the page read as one page rather than six.
 */
export function SectionHeading({
  eyebrow,
  title,
  sub,
  className,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  className?: string;
}): ReactNode {
  return (
    <Reveal>
      <div className={cn('max-w-3xl', className)}>
        <Badge variant="kortix" className="rounded">
          {eyebrow}
        </Badge>
        <h2 className="text-foreground mt-6 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          {title}
        </h2>
        <p className="text-muted-foreground mt-4 text-base leading-relaxed">{sub}</p>
      </div>
    </Reveal>
  );
}
