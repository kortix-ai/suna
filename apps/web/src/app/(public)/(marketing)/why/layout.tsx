import type { ReactNode } from 'react';

import { marketingMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

/**
 * /why is the long-form product narrative that used to be the homepage, so it
 * carries the homepage's SEO record — same title, same description, same
 * content. Only the canonical is overridden: the record's htmlPath stays `/`
 * because an agent asking kortix.com for text/markdown must still get the
 * overview, even though the HTML at `/` is the product shell now.
 */
const base = marketingMetadata('/');

export const metadata = {
  ...base,
  alternates: { ...base.alternates, canonical: `${CANONICAL_ORIGIN}/why` },
};

export default function WhyLayout({ children }: { children: ReactNode }) {
  return children;
}
