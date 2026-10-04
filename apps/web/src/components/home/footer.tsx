'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { closing, osHero } from '@/features/marketing/os/content';
import { DemoPill, PillLink } from '@/features/marketing/os/primitives';
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
      { label: 'Agent Computer', href: '/agent-computer' },
      { label: 'Company as Code', href: '/company-as-code' },
      { label: 'Connectors', href: '/connectors' },
      { label: 'Automations', href: '/automations' },
      { label: 'Channels', href: '/channels' },
      { label: 'Agents & Skills', href: '/agents-and-skills' },
      { label: 'Security', href: '/security' },
      { label: 'Self-hosted', href: '/self-hosted' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Download', href: '/download' },
    ],
  },
  {
    // Pulled out of the top bar: eight roles is a wide menu beside Product and
    // Company, and a reader looking for their own function looks down here.
    title: 'Solutions',
    links: [
      { label: 'Sales', href: '/solutions/sales' },
      { label: 'Marketing', href: '/solutions/marketing' },
      { label: 'Engineering', href: '/solutions/engineering' },
      { label: 'Product', href: '/solutions/product' },
      { label: 'Finance', href: '/solutions/finance' },
      { label: 'People', href: '/solutions/people' },
      { label: 'IT', href: '/solutions/it' },
      { label: 'Data Science', href: '/solutions/data-science' },
    ],
  },
  {
    title: 'Developers',
    links: [
      // /docs/reference/cli 404s — there is no reference/ directory. The page
      // is content/docs/cli.mdx, routed at /docs/cli.
      { label: 'Documentation', href: '/docs' },
      { label: 'CLI', href: '/docs/cli' },
      { label: 'SDK', href: '/docs/sdk' },
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'For developers', href: '/developers' },
      { label: 'Marketplace', href: '/marketplace' },
      { label: 'GitHub', href: 'https://github.com/kortix-ai/suna', external: true },
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
    <section className="dark bg-background text-foreground relative overflow-hidden">
      {/* The close every marketing page ends on, on the Beams art. */}
      <div className="relative overflow-hidden">
        <BeamsShader />
        <div className="from-background via-background/30 to-background absolute inset-0 bg-linear-to-b" aria-hidden />
        <div className="relative mx-auto flex max-w-7xl flex-col items-center gap-8 px-6 py-30 text-center md:py-40">
          <h2 className="text-foreground max-w-3xl text-3xl font-normal tracking-tight text-balance sm:text-5xl">
            {closing.title}
          </h2>
          <div className="flex flex-wrap justify-center gap-3">
            <PillLink href={closing.primary.href}>{closing.primary.label}</PillLink>
            <DemoPill source="footer-closing">{closing.secondary.label}</DemoPill>
          </div>
        </div>
      </div>

      <footer id="site-footer" className="relative z-10 border-t">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 pt-16 pb-12 lg:grid-cols-[1fr_3fr]">
          <div className="flex flex-col items-start gap-5">
            <KortixLogo size={22} variant="logomark" />
            <p className="text-muted-foreground max-w-xs text-sm text-pretty">{osHero.title}</p>
            <PillLink href={closing.primary.href} className="h-9 px-4 text-sm">
              {closing.primary.label}
            </PillLink>
          </div>
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

      {/* The giant wordmark, cropped by the bottom edge of the page. An alpha
          mask painted with the foreground token. */}
      <div aria-hidden className="h-[20vw] overflow-hidden">
        <div
          className="bg-foreground aspect-[1440/381] w-full opacity-15"
          style={{
            maskImage: 'url(/marketing/dither-wordmark.png)',
            WebkitMaskImage: 'url(/marketing/dither-wordmark.png)',
            maskSize: 'contain',
            WebkitMaskSize: 'contain',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            maskPosition: 'top',
            WebkitMaskPosition: 'top',
          }}
        />
      </div>
    </section>
  );
};

export default Footer;
