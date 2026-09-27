import { localeStaticParams } from '@/i18n/static-params';

import { MarketingShell } from './marketing-shell';

// Prerender every marketing page once per locale (see i18n/static-params.ts).
export const generateStaticParams = localeStaticParams;

export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <MarketingShell>{children}</MarketingShell>;
}
