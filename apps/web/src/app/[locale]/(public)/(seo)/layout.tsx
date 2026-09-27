import { localeStaticParams } from '@/i18n/static-params';

import { SeoShell } from './seo-shell';

// Prerender every SEO page once per locale (see i18n/static-params.ts).
export const generateStaticParams = localeStaticParams;

export default function SeoLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SeoShell>{children}</SeoShell>;
}
