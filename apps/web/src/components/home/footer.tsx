'use client';

import { CtaSection } from '@/features/marketing/landing/cta-section';
import { FOOTER_TRANSLATION_KEYS } from '@/i18n/footer-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';
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
      { label: 'The AI Operating System', href: '/product' },
      { label: 'Agents', href: '/product#agents' },
      { label: 'Connect everything', href: '/product#connect' },
      { label: 'Runs on its own', href: '/product#automate' },
      { label: 'Secure and yours', href: '/product#control' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Download', href: '/download' },
    ],
  },
  {
    title: 'Services',
    links: [
      { label: 'AI-native restructuring', href: '/services' },
      { label: 'How it works', href: '/services#how' },
      { label: 'Your team', href: '/services#team' },
      { label: 'Customer stories', href: '/customers' },
      { label: 'Contact', href: '/contact' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'CLI', href: '/docs/cli' },
      { label: 'SDK', href: '/docs/sdk' },
      { label: 'Marketplace', href: '/marketplace' },
      { label: 'GitHub', href: 'https://github.com/kortix-ai/suna', external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Customers', href: '/customers' },
      { label: 'Careers', href: '/careers' },
      { label: 'Blog', href: '/blog' },
      { label: 'Changelog', href: '/changelog' },
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
      { label: 'Support', href: '/support' },
      { label: 'Terms', href: '/legal/terms' },
      { label: 'Privacy', href: '/legal?tab=privacy' },
    ],
  },
];

function FooterLink({ label, href, external }: FooterLinkItem) {
  const className = cn(
    'group flex w-full min-w-0 items-baseline py-1 text-sm hover:text-foreground text-muted-foreground/90 whitespace-nowrap',
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

      <footer id="site-footer" className="relative z-10">
        <div className="mx-auto mb-12 max-w-7xl px-6">
          <nav>
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-5">
              {footerSections.map((section) => (
                <div key={section.title} className="min-w-0 space-y-2">
                  <h3 className="text-foreground text-sm">{section.title}</h3>
                  <ul className="space-y-0">
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

        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 border-t p-6 md:flex-row md:items-center">
          <div className="text-muted-foreground flex items-center gap-3 text-base">
            <small>
              {tI18nHardcoded.raw('autoComponentsHomeFooterJsxTextCopye99743e8')}
              {currentYear} {tI18nHardcoded.raw('i18nComplete.textab54cf5e1d9d')}
            </small>
          </div>

          <ThemeToggle variant="compact" systemTheme={false} />
        </div>
      </footer>

      {/* Dithered wordmark: an alpha mask painted with the foreground token, so it follows the theme. */}
      <div
        aria-hidden
        className="bg-foreground mx-auto mt-6 aspect-[1440/381] w-full max-w-7xl opacity-15"
        style={{
          maskImage: 'url(/marketing/dither-wordmark.png)',
          WebkitMaskImage: 'url(/marketing/dither-wordmark.png)',
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'bottom',
          WebkitMaskPosition: 'bottom',
        }}
      />
    </section>
  );
};

export default Footer;
