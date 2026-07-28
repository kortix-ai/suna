'use client';

import { MarketingPage } from '@/features/marketing/v2/marketing-page';
import { PAGES } from '@/features/marketing/v2/pages-content';

export default function Page() {
  return <MarketingPage spec={PAGES['careers']} />;
}
