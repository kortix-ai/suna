'use client';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';

import Link from '@/components/site-link';
import { isServicesPagesEnabled } from '@/lib/config';
import { cn } from '@kortix/ui';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';

/** The site's two halves: the product and the done-for-you service. */
const sourceSITES = [
  { id: 'os', label: 'CompanyOS', href: '/' },
  { id: 'services', label: 'Services', href: '/services' },
] as const;

/**
 * Two plain text links between the CompanyOS site and the /services sales page,
 * split by a muted slash: the current half in ink, the other muted. No
 * segmented control: on marketing pages, links are text, never pills.
 * Sits next to the logo in both headers.
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
      className={cn('flex items-center gap-1 text-sm', className)}
    >
      {SITES.map((site, i) => (
        <Fragment key={site.id}>
          {i > 0 ? (
            <span aria-hidden className="text-muted-foreground/50 select-none">
              /
            </span>
          ) : null}
          <Link
            href={site.href}
            aria-current={site.id === current ? 'page' : undefined}
            className="text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground outline-ring duration-moderate flex h-8 items-center rounded-sm px-1.5 whitespace-nowrap transition-colors focus-visible:outline-2"
          >
            {site.label}
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
