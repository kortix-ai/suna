'use client';

import { FaqSection } from '@/features/marketing/faq';
import { Developers, EnterpriseRows, Plans, Team } from '@/features/marketing/os/closing-sections';
import { OsHero } from '@/features/marketing/os/hero';
import { LogoWall } from '@/features/marketing/os/logo-wall';
import { OsLayer } from '@/features/marketing/os/os-layer';
import { ProductTabs } from '@/features/marketing/os/product-tabs';
import { Statement } from '@/features/marketing/os/statement';
import { WorkCarousel } from '@/features/marketing/os/work-carousel';

/**
 * The AI OS home, in the order a reader needs it: what it is (hero, then the
 * real product), what it runs (models and apps), what it finishes (real
 * artifacts per team), the thesis, the operating layer, the product tour, the
 * command line, the security review, the price, the questions, the team and
 * the close.
 */
export default function Home() {
  return (
    <div className="bg-background relative">
      <OsHero />
      <LogoWall />
      <WorkCarousel />
      <Statement />
      <OsLayer />
      <ProductTabs />
      <Developers />
      <EnterpriseRows />
      <Plans />
      <FaqSection />
      <Team />
    </div>
  );
}
