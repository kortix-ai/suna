'use client';

import { CtaSection } from '@/features/marketing/landing/cta-section';
import { FOOTER_TRANSLATION_KEYS } from '@/i18n/footer-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { cn } from '@kortix/ui';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
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
      { label: 'Security', href: '/security' },
      { label: 'Self-hosted', href: '/self-hosted' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Download', href: '/download' },
      { label: 'Mobile', href: '/mobile' },
    ],
  },
  {
    title: 'Developers',
    links: [
      // /docs/reference/cli 404s — there is no reference/ directory. The page
      // is content/docs/cli.mdx, routed at /docs/cli.
      { label: 'Documentation', href: '/docs' },
      { label: 'CLI', href: '/docs/cli' },
      { label: 'Developers', href: '/developers' },
      { label: 'Marketplace', href: '/marketplace' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Careers', href: '/careers' },
      { label: 'Blog', href: '/blog' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Use Cases', href: '/use-cases' },
      { label: 'Brand', href: '/design-system' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'X', href: 'https://x.com/kortix', external: true },
      { label: 'LinkedIn', href: 'https://linkedin.com/company/kortix', external: true },
      { label: 'Discord', href: 'https://discord.com/invite/RvFhXUdZ9H', external: true },
      { label: 'Status', href: 'https://status.kortix.com', external: true },
      { label: 'Contact', href: '/contact' },
      { label: 'Terms', href: '/legal/terms' },
      { label: 'Privacy', href: '/legal?tab=privacy' },
    ],
  },
];

function FooterLink({ label, href, external }: FooterLinkItem) {
  const className = cn(
    'text-foreground hover:text-muted-foreground flex w-full min-w-0 items-baseline py-1 text-sm whitespace-nowrap transition-colors duration-normal ease-out',
  );

  if (external) {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <span className="min-w-0">{label}</span>
      </Link>
    );
  }

  return (
    <Link href={href} className={className}>
      <span className="min-w-0">{label}</span>
    </Link>
  );
}

const Footer = () => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const footerSections = localizeUiCatalog(FOOTER_SECTIONS, tI18nComplete, FOOTER_TRANSLATION_KEYS);
  const currentYear = new Date().getFullYear();

  return (
    <section className="from-card to-background relative overflow-hidden border-t bg-linear-to-b from-30% to-90% pt-12">
      <CtaSection />

      {/* Polar's layout: the mark top left, the copyright and theme switch
          pinned to the bottom of the same column; the link groups in a grid
          on the right. */}
      <footer id="site-footer" className="relative z-10">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-6 pt-12 pb-16 lg:grid-cols-12">
          <div className="flex flex-col justify-between gap-12 lg:col-span-5">
            <Link href="/" aria-label="Kortix home" className="text-foreground outline-ring w-fit rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2">
              <KortixLogo size={22} variant="logomark" />
            </Link>

            <div className="flex items-center gap-4">
              <small className="text-muted-foreground text-sm">
                {tI18nHardcoded.raw('autoComponentsHomeFooterJsxTextCopye99743e8')}
                {currentYear} {tI18nHardcoded.raw('i18nComplete.textab54cf5e1d9d')}
              </small>
              <ThemeToggle variant="compact" systemTheme={false} />
            </div>
          </div>

          <nav aria-label="Footer" className="lg:col-span-7">
            <div className="grid grid-cols-2 gap-x-6 gap-y-12 md:grid-cols-4">
              {footerSections.map((section) => (
                <div key={section.title} className="min-w-0">
                  <h3 className="text-muted-foreground text-sm">{section.title}</h3>
                  <ul className="mt-4 flex flex-col gap-1">
                    {section.links.map((link) =>
                      process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false' &&
                      link.href === '/use-cases' ? null : (
                        <li key={link.label}>
                          <FooterLink {...link} />
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </nav>
        </div>
      </footer>

    </section>
  );
};

export default Footer;
