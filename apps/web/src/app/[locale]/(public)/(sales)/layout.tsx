import { SalesShell } from '@/features/marketing/services/sales-shell';
import { localeStaticParams } from '@/i18n/static-params';

// Prerender every sales page once per locale (see i18n/static-params.ts).
export const generateStaticParams = localeStaticParams;

export default function SalesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SalesShell>{children}</SalesShell>;
}
