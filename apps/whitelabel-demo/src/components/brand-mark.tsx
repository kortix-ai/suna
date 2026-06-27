import { BRAND } from '@/config/brand';
import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div
        className="grid size-7 place-items-center rounded-lg text-sm font-bold text-[var(--color-accent-fg)]"
        style={{ background: BRAND.accent }}
      >
        {BRAND.name.charAt(0)}
      </div>
      <span className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
        {BRAND.name}
      </span>
    </div>
  );
}
