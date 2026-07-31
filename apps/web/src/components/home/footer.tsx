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

/**
 * The footer is the full map of the site — every destination the top bar shows
 * plus the ones it deliberately does not. Product mirrors `productMenu`,
 * Solutions carries the eight role pages that were pulled out of the nav, and
 * Company mirrors `companyMenu`. Keep this in step with `lib/site-config.ts`:
 * a page that exists in neither place is a page nobody can find.
 */
const FOOTER_SECTIONS: FooterSection[] = [
  {
    title: 'Product',
    links: [
      { label: 'Agent Computer', href: '/agent-computer' },
      { label: 'Company as Code', href: '/company-as-code' },
      { label: 'Integrations', href: '/integrations' },
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
      { label: 'Terms', href: '/legal?tab=terms' },
      { label: 'Privacy', href: '/legal?tab=privacy' },
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
    <footer id="site-footer" className="bg-card relative pt-12 pb-12 md:pb-16">
      <div className="mx-auto mb-12 max-w-7xl px-6">
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

      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-6 md:flex-row md:items-center">
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
