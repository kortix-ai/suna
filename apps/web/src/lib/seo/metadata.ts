import type { Metadata } from 'next';

import { getMarketingRecord } from '@/lib/seo/public-content';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export function marketingMetadata(pathname: string): Metadata {
  const record = getMarketingRecord(pathname);
  if (!record) throw new Error(`Missing marketing SEO record for ${pathname}`);
  const url = `${CANONICAL_ORIGIN}${pathname}`;
  return {
    title: record.title,
    description: record.description,
    alternates: { canonical: url },
    openGraph: {
      title: record.title,
      description: record.description,
      url,
      siteName: 'Kortix',
      type: 'website',
    },
  };
}
