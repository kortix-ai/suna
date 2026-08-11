export type NavSubLink = {
  href: string;
  name: string;
  description?: string;
  /** Absolute destination off dosco.live — opens in a new tab. */
  external?: boolean;
};

export type NavMenuColumn = {
  title: string;
  links: NavSubLink[];
};

/**
 * A menu is its links and nothing else. Both menus previously carried a promo
 * strip along the bottom; it added a row of chrome to every hover without
 * adding a destination, so the shape no longer has one.
 */
export type NavMenu = {
  columns: NavMenuColumn[];
};

export type NavLink =
  | { id: number; name: string; href: string }
  | { id: number; name: string; href: NavSubLink[] }
  | { id: number; name: string; menu: NavMenu };

import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export const productMenu: NavMenu = {
  columns: [
    {
      title: 'Platform',
      links: [
        {
          name: 'Agent Computer',
          href: '/agent-computer',
          description: 'An isolated cloud computer for every session',
        },
        {
          name: 'Company as Code',
          href: '/company-as-code',
          description: 'Agents, skills and memory as git files you own',
        },
        {
          name: 'Self-hosted',
          href: '/self-hosted',
          // ACCURACY: never "air-gapped" — `self-host start` pulls images from
          // docker.io, so a fully disconnected install is not shipped.
          description: 'Your own VPC or your own on-prem network',
        },
        {
          name: 'Security',
          href: '/security',
          description: 'Isolation, credentials, permissions and audit',
        },
        {
          name: 'Enterprise',
          href: '/enterprise',
          description: 'SSO, RBAC, audit trails and approval gates',
        },
      ],
    },
    {
      title: 'Capabilities',
      links: [
        {
          name: 'Connectors',
          href: '/connectors',
          description: '3,000+ apps through one scoped token',
        },
        {
          name: 'Automations',
          href: '/automations',
          description: 'Cron schedules and signed webhooks',
        },
        {
          name: 'Channels',
          href: '/channels',
          description: 'Slack threads that start real sessions',
        },
        {
          name: 'Agents & Skills',
          href: '/agents-and-skills',
          description: 'A workforce that compounds what it learns',
        },
      ],
    },
  ],
};

/**
 * The role axis. Eight `/solutions/<role>` pages, split into the two columns the
 * renderer supports (a third column would render into a two-column grid).
 *
 * The labels and hrefs are hand-written here rather than derived from
 * `features/marketing/solutions/registry`, because this module is imported by
 * the client navbar — importing the registry would ship every word of all eight
 * role pages in the client bundle. Keep the names in step with the `name` field
 * on each role, and with the home-page use-case cards, which sit on the same
 * axis: "Data Science", not "Data"; "People", not "HR" or "Recruiting".
 */
export const solutionsMenu: NavMenu = {
  columns: [
    {
      title: 'Product & engineering',
      links: [
        {
          name: 'Engineering',
          href: '/solutions/engineering',
          description: 'Reproduce it, patch it, open the change request',
        },
        {
          name: 'Product',
          href: '/solutions/product',
          description: 'Feedback synthesised into specs, with the evidence',
        },
        {
          name: 'Data Science',
          href: '/solutions/data-science',
          description: 'A real machine, a real query, an analysis you can re-run',
        },
        {
          name: 'IT',
          href: '/solutions/it',
          description: 'Runbooks that execute, and a platform you can review',
        },
      ],
    },
    {
      title: 'Business & operations',
      links: [
        {
          name: 'Sales',
          href: '/solutions/sales',
          description: 'Research, drafts and CRM hygiene, held for approval',
        },
        {
          name: 'Marketing',
          href: '/solutions/marketing',
          description: 'Production work that sounds like you',
        },
        {
          name: 'Finance',
          href: '/solutions/finance',
          description: 'The close, the reconciliation and the variance note',
        },
        {
          name: 'People',
          href: '/solutions/people',
          description: 'Scheduling, kits and onboarding — never the decision',
        },
      ],
    },
  ],
};

/**
 * One column, no descriptions — five short destinations read faster as a list
 * than as a grid of explained cards, and a narrow panel stops the menu from
 * spanning half the viewport for five links.
 */
export const companyMenu: NavMenu = {
  columns: [
    {
      title: 'Company',
      links: [
        { name: 'About', href: '/about' },
        { name: 'Careers', href: '/careers' },
        { name: 'Blog', href: '/blog' },
        { name: 'X', href: 'https://x.com/kortix', external: true },
        { name: 'LinkedIn', href: 'https://linkedin.com/company/kortix', external: true },
      ],
    },
  ],
};

export const siteConfig = {
  url: CANONICAL_ORIGIN,
  nav: {
    links: [
      { id: 1, name: 'Product', menu: productMenu },
      // Solutions is deliberately NOT in the top bar. Eight role pages is a
      // wide menu beside Product and Company; the roles live in the footer,
      // and the home-page use-case cards are the in-page entry point.
      { id: 3, name: 'Company', menu: companyMenu },
      { id: 4, name: 'Pricing', href: '/pricing' },
      { id: 6, name: 'Docs', href: '/docs' },
    ] as NavLink[],
  },
  hero: {
    description: 'dosco – the open agent network for your company.',
  },
  footerLinks: [
    {
      title: 'Product',
      links: [
        { id: 4, title: 'Support', url: '/support' },
        { id: 5, title: 'Contact', url: 'mailto:hey@dosco.live' },
        { id: 13, title: 'Status', url: 'https://status.dosco.live' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 7, title: 'Documentation', url: '/docs' },
        { id: 8, title: 'Discord', url: 'https://discord.com/invite/RvFhXUdZ9H' },
        { id: 9, title: 'GitHub', url: 'https://github.com/kortix-ai/suna' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { id: 10, title: 'Privacy Policy', url: '/legal?tab=privacy' },
        { id: 11, title: 'Terms of Service', url: '/legal/terms' },
        { id: 12, title: 'License', url: 'https://github.com/kortix-ai/suna/blob/main/LICENSE' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
