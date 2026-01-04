'use client';

import { useEffect } from 'react';
import { Gift, Clock } from 'lucide-react';
import { usePromo } from '@/hooks/utils/use-promo';

interface PromoBannerProps {
  className?: string;
}

export function PromoBanner({ className }: PromoBannerProps) {
  const promo = usePromo();

  useEffect(() => {
    if (promo && process.env.NODE_ENV !== 'production') {
      // Helpful during development/debugging; logs only when the active promo changes.
      // eslint-disable-next-line no-console
      console.log('[PromoBanner] promo', promo);
    }
  }, [promo?.promoId]);

  // Don't render if no active promo
  if (!promo || !promo.isActive) {
    return null;
  }

  return (
    <div className={`animate-in fade-in-0 slide-in-from-top-2 duration-300 delay-150 fill-mode-both ${className || ''}`}>
      <div className="inline-flex items-center gap-3 px-4 py-2.5 rounded-full bg-primary/5 border border-primary/10 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Gift className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            <span className="font-semibold">{promo.badgeLabel}</span>
            <span className="text-muted-foreground mx-1.5">·</span>
            <span className="text-primary font-semibold">{promo.promoCode}</span> · {promo.description}
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{promo.timeLabel}</span>
        </div>
      </div>
    </div>
  );
}

