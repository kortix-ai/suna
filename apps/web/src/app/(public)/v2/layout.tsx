'use client';

import { MarketingFooter } from '@/features/marketing/v2/footer';
import { MarketingNav } from '@/features/marketing/v2/nav';

export default function MarketingV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh w-full">
      <MarketingNav />
      {children}
      <MarketingFooter />
    </div>
  );
}
