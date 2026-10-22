import type { Metadata } from 'next';

/**
 * The sign-in screen is a waypoint, never a destination: every URL a crawler
 * could land on there is a duplicate of a page it can already index, and an
 * anonymous visitor's `next` parameter makes each one unique. A pentest
 * (2026-10-22) found `/auth` advertising `index, follow`. `nofollow` is
 * deliberately absent: the links out of the page are worth crawling.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
