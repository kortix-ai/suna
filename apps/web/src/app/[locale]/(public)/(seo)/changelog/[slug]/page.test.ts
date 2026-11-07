import { describe, expect, mock, test } from 'bun:test';

import type { ChangelogWeekDetail } from '@/features/marketing/changelog/types';

const cover = {
  url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png',
  alt: 'Reviewed cover',
  width: 1600,
  height: 900,
};
let detail: ChangelogWeekDetail;
mock.module('server-only', () => ({}));
const releases = await import('@/features/marketing/changelog/releases');
mock.module('@/features/marketing/changelog/releases', () => ({ ...releases, getChangelogWeek: async () => detail }));

const { generateMetadata } = await import('./page');

function week(media?: ChangelogWeekDetail['week']['media']): ChangelogWeekDetail {
  return {
    week: {
      id: '2026-W44',
      slug: '2026-10-26',
      start: '2026-10-26T00:00:00Z',
      end: '2026-11-02T00:00:00Z',
      inProgress: false,
      headline: 'Weekly headline',
      releases: [],
      highlights: [],
      summary: null,
      media,
      counts: { new: 1, improved: 0, fixed: 0 },
    },
    sections: { new: null, improved: null, fixed: null },
  };
}

const params = Promise.resolve({ slug: '2026-10-26' });

describe('changelog week share metadata', () => {
  test('a reviewed cover is the Open Graph and Twitter image, with its size and alt text', async () => {
    detail = week({ cover });
    const metadata = await generateMetadata({ params });
    expect(metadata.openGraph?.images).toEqual([cover]);
    expect(metadata.twitter?.images).toEqual([cover.url]);
  });

  test('a week without media keeps the default banner', async () => {
    detail = week();
    const metadata = await generateMetadata({ params });
    expect(metadata.openGraph?.images).toEqual([{ url: '/banner.png', width: 1200, height: 630, alt: 'Weekly headline' }]);
    expect(metadata.twitter?.images).toEqual(['/banner.png']);
  });
});
