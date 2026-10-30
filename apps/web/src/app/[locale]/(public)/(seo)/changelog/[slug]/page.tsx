import { CANONICAL_ORIGIN } from '@kortix/ui/internal/lib/site-metadata';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getChangelogWeek } from '@/features/marketing/changelog/releases';
import { WeekView } from '@/features/marketing/changelog/week-view';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await getChangelogWeek((await params).slug);
  // Metadata resolves before the page streams, so this answers a real 404.
  if (!data) notFound();
  const { week } = data;
  const url = `${CANONICAL_ORIGIN}/changelog/${week.slug}`;
  const description = `What shipped in Kortix that week: ${week.counts.new} new features, ${week.counts.improved} improvements and ${week.counts.fixed} fixes.`;
  return {
    title: week.headline,
    description,
    openGraph: {
      title: week.headline,
      description,
      url,
      siteName: 'Kortix',
      type: 'article',
      publishedTime: week.start,
      images: [{ url: '/banner.png', width: 1200, height: 630, alt: week.headline }],
    },
    twitter: {
      card: 'summary_large_image',
      title: week.headline,
      description,
      images: ['/banner.png'],
    },
    alternates: { canonical: url },
  };
}

// Same hourly rebuild as /changelog: a week in progress gains releases.
export const revalidate = 3600;

export default async function ChangelogWeekPage({ params }: Props) {
  const data = await getChangelogWeek((await params).slug);
  if (!data) notFound();
  return <WeekView data={data} />;
}
