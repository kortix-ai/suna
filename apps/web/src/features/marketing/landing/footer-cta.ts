import { getLocalizedAboutContent } from '@/features/marketing/about/content';
import { locales } from '@/i18n/config';
import type { UiTranslator } from '@/i18n/translator';

/**
 * Per-page copy for the footer's call to action (`cta-section.tsx`). A page
 * not listed here keeps the default close: "Run your whole company from one
 * repo you own", Get started and Request demo. To customise a page, add its
 * path (no locale prefix) with the copy it should end on.
 */
export type FooterCtaAction = { label: string; href: string; external?: boolean };

export type FooterCtaOverride = {
  title: string;
  subtitle: string;
  sub?: string;
  primary: FooterCtaAction;
  secondary: FooterCtaAction;
};

const OVERRIDES: Record<string, (t: UiTranslator) => FooterCtaOverride> = {
  // /about ends on the hiring call instead of a sign-up.
  '/about': (t) => {
    const { closing } = getLocalizedAboutContent(t);
    return {
      title: closing.title,
      subtitle: closing.titleMuted,
      primary: { label: closing.ctaPrimary, href: closing.ctaPrimaryHref },
      secondary: { label: closing.ctaSecondary, href: closing.ctaSecondaryHref, external: true },
    };
  },
};

/** The override for `pathname` (with or without a locale prefix), if any. */
export function footerCtaFor(pathname: string, t: UiTranslator): FooterCtaOverride | null {
  const [, first, ...rest] = pathname.split('/');
  const path = (locales as readonly string[]).includes(first) ? `/${rest.join('/')}` : pathname;
  return OVERRIDES[path.replace(/\/$/, '') || '/']?.(t) ?? null;
}
