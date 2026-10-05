import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { localeStaticParams } from '@/i18n/static-params';

// Prerender every deck and film once per locale, like the marketing pages. The
// middleware rewrites an unprefixed URL onto /en/… with request headers; a page
// that was not prerendered for that locale then renders on demand, calls a
// dynamic API, and fails with DYNAMIC_SERVER_USAGE (500) in production builds.
export const generateStaticParams = localeStaticParams;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  return {
    title: t.raw('textd84b8be91e7b'),
    description: t.raw('text2e7ba6cc8aa3'),
    robots: { index: false, follow: false },
  };
}

/**
 * Full-bleed shell for every deck and the index — no marketing navbar or
 * footer. Fonts, theme tokens and providers come from the root layout; a deck
 * page positions itself `fixed inset-0` inside this.
 */
export default function PresentationsLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh w-full overflow-hidden">{children}</div>;
}
