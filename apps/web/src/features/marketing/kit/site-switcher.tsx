'use client';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';

import Link from '@/components/site-link';
import { isServicesPagesEnabled } from '@/lib/config';
import { cn } from '@kortix/ui';
import { usePathname } from 'next/navigation';

/** The site's two halves: the product and the done-for-you service. */
const sourceSITES = [
  { id: 'os', label: 'AI OS', href: '/' },
  { id: 'services', label: 'Services', href: '/services' },
] as const;

/**
 * A segmented pair of links between the AI OS site and the /services sales
 * page. The current half is filled. Sits next to the logo in both headers.
 */
export function SiteSwitcher({ className }: { className?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { SITES } = localizeUiCatalog(
    { SITES: sourceSITES },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  const current = /\/services\/?$/.test(usePathname() ?? '') ? 'services' : 'os';
  // Without /services there is only one half: no switcher.
  if (!isServicesPagesEnabled()) return null;
  return (
    <nav
      aria-label={tMarketing('textfa7955814e32')}
      className={cn('bg-muted flex items-center rounded-md p-0.5', className)}
    >
      {SITES.map((site) => (
        <Link
          key={site.id}
          href={site.href}
          aria-current={site.id === current ? 'page' : undefined}
          className="text-muted-foreground hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground outline-ring duration-moderate flex h-7 items-center rounded-sm px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2"
        >
          {site.label}
        </Link>
      ))}
    </nav>
  );
}
