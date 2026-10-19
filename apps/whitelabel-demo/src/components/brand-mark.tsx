import { BRAND } from '@/config/brand';
import { cn } from '@kortix/ui';

export function BrandMark({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* Lumen's mark: a lit aperture, drawn in the brand color. */}
      <svg viewBox="0 0 28 28" aria-hidden className="size-7 shrink-0 text-brand">
        <circle cx="14" cy="14" r="13" fill="currentColor" opacity="0.16" />
        <circle cx="14" cy="14" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="14" cy="14" r="3.75" fill="currentColor" />
      </svg>
      {showWordmark && (
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {BRAND.name}
        </span>
      )}
    </div>
  );
}
