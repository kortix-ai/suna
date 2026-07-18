'use client';

import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

type FooterLinkItem = {
  label: string;
  href: string;
  external?: boolean;
};

type FooterSection = {
  title: string;
  links: FooterLinkItem[];
};

const FOOTER_SECTIONS: FooterSection[] = [
  {
    title: 'Product',
    links: [
      { label: 'CLI', href: '/docs/reference/cli' },
      { label: 'Developers', href: '/developers' },
      { label: 'Marketplace', href: '/marketplace' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Pricing', href: '/pricing' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Use Cases', href: '/use-cases' },
      { label: 'Blog', href: '/blog' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Docs', href: '/docs' },
      { label: 'Brand', href: '/design-system' },
      { label: 'Status', href: 'https://status.kortix.com', external: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms', href: '/legal?tab=terms' },
      { label: 'Privacy', href: '/legal?tab=privacy' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'X', href: 'https://x.com/kortix', external: true },
      { label: 'LinkedIn', href: 'https://linkedin.com/company/kortix', external: true },
    ],
  },
];

function FooterLink({ label, href, external }: FooterLinkItem) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const className = cn('group inline-block py-1 text-sm text-foreground transition-colors ');

  if (external) {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
        <span className="inline-block opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {tI18nHardcoded.raw('autoComponentsHomeFooterJsxText4e1e5394')}
        </span>
      </Link>
    );
  }

  return (
    <Link href={href} className={className}>
      {label}
      <span className="inline-block opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {tI18nHardcoded.raw('autoComponentsHomeFooterJsxText4e1e5394')}
      </span>
    </Link>
  );
}

const Footer = () => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const currentYear = new Date().getFullYear();

  return (
    <footer id="site-footer" className="bg-card relative px-6 pt-12 pb-12 md:pb-16">
      <div className="mx-auto mb-12 max-w-6xl lg:px-0">
        <nav>
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-5">
            {FOOTER_SECTIONS.map((section) => (
              <div key={section.title}>
                <h3 className="text-muted-foreground pb-2 text-sm">{section.title}</h3>
                <ul className="space-y-0">
                  {section.links
                    .filter(
                      (link) =>
                        process.env.NEXT_PUBLIC_USE_CASES_ENABLED !== 'false' ||
                        link.href !== '/use-cases',
                    )
                    .map((link) => (
                    <li key={link.label}>
                      <FooterLink {...link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      </div>

      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 md:flex-row md:items-center lg:px-0">
        <div className="text-muted-foreground flex items-center gap-3 text-base">
          <small>
            {tI18nHardcoded.raw('autoComponentsHomeFooterJsxTextCopye99743e8')}
            {currentYear} Kortix
          </small>
        </div>

        <ThemeToggle variant="compact" />
      </div>
    </footer>
  );
};

export default Footer;
