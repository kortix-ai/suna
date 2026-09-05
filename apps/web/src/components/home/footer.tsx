'use client';

import { CtaSection } from '@/features/marketing/landing/cta-section';
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
      { label: 'Changelog', href: '/docs/changelog' },
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
  const currentYear = new Date().getFullYear();

  return (
    <section className="from-card to-background relative overflow-hidden border-t bg-linear-to-b from-30% to-90% pt-12 pb-12 md:pb-16">
      <CtaSection />

      <footer id="site-footer" className="relative z-10">
        <div className="mx-auto mb-12 max-w-7xl px-6">
          <nav>
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-5">
              {FOOTER_SECTIONS.map((section) => (
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
              {currentYear} Kortix
            </small>
          </div>

          <ThemeToggle variant="compact" systemTheme={false} />
        </div>
      </footer>
    </section>
  );
};

export default Footer;
