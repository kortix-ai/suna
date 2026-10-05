import { SolutionsHubPage } from '@/features/marketing/solutions/hub-page';
import type { ReactNode } from 'react';

/**
 * `/solutions` — the front door for the eight role pages.
 *
 * Metadata comes from the `/solutions` record in `lib/seo/public-content.ts`
 * through this route's `layout.tsx`, the same way every other marketing page
 * does it. A route with no record throws at build time, by design.
 */
export default function SolutionsPage(): ReactNode {
  return <SolutionsHubPage />;
}
