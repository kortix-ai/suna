'use client';

import { Badge } from '@/components/ui/badge';
import { usePromo } from '@/hooks/utils/use-promo';

interface PromoBannerProps {
  className?: string;
}

export function PromoBanner({ className }: PromoBannerProps) {
  const promo = usePromo();

  // Don't render if no active promo
  if (!promo || !promo.isActive) {
    return null;
  }

  // Simple, minimal hero section banner - different from dashboard banner
  return (
    <div className={`w-full max-w-2xl mx-auto px-4 sm:px-0 mb-6 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both ${className || ''}`}>
      <div className="flex flex-col items-center justify-center gap-2 text-center">
        <Badge className="rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]">
          {promo.badgeLabel}
        </Badge>
        <p className="text-sm font-medium text-foreground tracking-tight">
          Use code <span className="font-semibold text-primary">{promo.promoCode}</span> to get <span className="font-semibold">30% off</span> for the first three months + <span className="font-semibold">2X credits</span> as welcome bonus
        </p>
        <p className="text-xs text-muted-foreground">
          Ends in {promo.timeLabel}
        </p>
      </div>
    </div>
  );
}

