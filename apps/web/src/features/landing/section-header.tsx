import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The shared section header for the landing page.
 *
 * Matches the current homepage's visual language exactly: a pill eyebrow, an
 * oversized left-aligned display heading, then a wide muted lead paragraph.
 * Every section on the page goes through this so the rhythm never drifts.
 */
export function SectionHeader({
  eyebrow,
  title,
  intro,
  className,
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  className?: string;
}) {
  return (
    <div className={cn('max-w-3xl', className)}>
      {eyebrow ? (
        <Badge variant="kortix" className="rounded">
          {eyebrow}
        </Badge>
      ) : null}
      <h2
        className={cn(
          'text-foreground text-4xl font-medium tracking-tight text-balance sm:text-5xl',
          eyebrow && 'mt-5',
        )}
      >
        {title}
      </h2>
      {intro ? (
        <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-relaxed">{intro}</p>
      ) : null}
    </div>
  );
}
