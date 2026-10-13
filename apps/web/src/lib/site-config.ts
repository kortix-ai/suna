export type NavSubLink = {
  href: string;
  name: string;
  description?: string;
  /** Absolute destination off kortix.com — opens in a new tab. */
  external?: boolean;
  /**
   * Icon slug rendered as a leading tile in the desktop dropdown. A string, not
   * a component: this module is imported by server code and the icon components
   * are client-only, so the slug→icon map lives in `product-menu.tsx`.
   */
  icon?: string;
};

export type NavMenuColumn = {
  title: string;
  links: NavSubLink[];
};

/**
 * The card on the left of a menu panel: the one page the menu is about. The
 * links beside it are sections of that story, so a menu reads as "this, and
 * these parts of it" instead of a flat list of pages.
 */
export type NavMenuFeature = {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  cta: string;
};

export type NavMenu = {
  feature?: NavMenuFeature;
  columns: NavMenuColumn[];
};

export type NavLink =
  | { id: number; name: string; href: string }
  | { id: number; name: string; href: NavSubLink[] }
  | { id: number; name: string; menu: NavMenu };

import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

/**
 * Three menus, one intent each: what we sell (the product), what we do for you
 * (the service), who we are (the company). Each links to one page and at most
 * four parts of it. The nine product pages that used to sit here are folded
 * into `/product`; their old URLs redirect to its sections (`next.config.ts`).
 */
export const productMenu: NavMenu = {
  feature: {
    eyebrow: 'Product',
    title: 'The AI Operating System',
    description:
      'Agents that do real work for your company, on their own computers, from one repo you own.',
    href: '/product',
    cta: 'See the product',
  },
  columns: [
    {
      title: 'The AI Operating System',
      links: [
        {
          name: 'Agents',
          href: '/product#agents',
          description: 'Skills, memory and their own cloud computer',
          icon: 'users',
        },
        {
          name: 'Connect everything',
          href: '/product#connect',
          description: '3,000+ apps, Slack and Microsoft Teams',
          icon: 'plugs',
        },
        {
          name: 'Runs on its own',
          href: '/product#automate',
          description: 'Schedules and webhooks, a person in the loop',
          icon: 'clock',
        },
        {
          name: 'Secure and yours',
          href: '/product#control',
          description: 'Permissions, audit, any model, any cloud',
          icon: 'shield',
        },
      ],
    },
  ],
};

export const servicesMenu: NavMenu = {
  feature: {
    eyebrow: 'Services',
    title: 'We make your company AI-native',
    description:
      'A strategist and a forward deployed engineer, inside your company, building on Kortix. $20k per month.',
    href: '/services',
    cta: 'See the service',
  },
  columns: [
    {
      title: 'Services',
      links: [
        {
          name: 'How it works',
          href: '/services#how',
          description: 'Map the work, unify the data, deploy agents',
          icon: 'git-branch',
        },
        {
          name: 'Your team',
          href: '/services#team',
          description: 'One strategist, one engineer, full time',
          icon: 'users',
        },
        {
          name: 'Customer stories',
          href: '/customers',
          description: 'Companies already running on agents',
          icon: 'buildings',
        },
        {
          name: 'Book a call',
          href: '/contact',
          description: 'Talk to us about your company',
          icon: 'chats',
        },
      ],
    },
  ],
};

export const companyMenu: NavMenu = {
  feature: {
    eyebrow: 'Company',
    title: 'Kortix runs on Kortix',
    description:
      'Our own sales, support and engineering run on the AI Operating System we sell.',
    href: '/about',
    cta: 'About us',
  },
  columns: [
    {
      title: 'Company',
      links: [
        {
          name: 'Customers',
          href: '/customers',
          description: 'How companies run on agents',
          icon: 'users',
        },
        { name: 'Careers', href: '/careers', description: 'Belgrade and San Francisco', icon: 'buildings' },
        { name: 'Changelog', href: '/changelog', description: 'What we shipped', icon: 'clock' },
        {
          name: 'GitHub',
          href: 'https://github.com/kortix-ai/suna',
          description: 'Open source. Read it, fork it, audit it.',
          icon: 'git-branch',
          external: true,
        },
      ],
    },
  ],
};

export const siteConfig = {
  url: CANONICAL_ORIGIN,
  nav: {
    links: [
      { id: 1, name: 'Product', menu: productMenu },
      { id: 2, name: 'Services', menu: servicesMenu },
      { id: 3, name: 'Company', menu: companyMenu },
      { id: 4, name: 'Pricing', href: '/pricing' },
      { id: 6, name: 'Docs', href: '/docs' },
    ] as NavLink[],
  },
  hero: {
    description: 'Kortix – the open-source AI Operating System.',
  },
  footerLinks: [
    {
      title: 'Product',
      links: [
        { id: 4, title: 'Support', url: '/support' },
        { id: 5, title: 'Contact', url: 'mailto:hey@kortix.com' },
        { id: 13, title: 'Status', url: 'https://status.kortix.com' },
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
        { id: 12, title: 'License', url: 'https://github.com/kortix-ai/suna/blob/dev/LICENSE' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
