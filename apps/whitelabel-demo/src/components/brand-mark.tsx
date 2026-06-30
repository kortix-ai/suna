import { BRAND } from '@/config/brand';
import { cn } from '@/lib/utils';

export function BrandMark({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
        {BRAND.name.charAt(0)}
      </div>
      {showWordmark && (
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {BRAND.name}
        </span>
      )}
    </div>
  );
}
