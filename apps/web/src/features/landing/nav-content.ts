/**
 * Navigation IA for the rebuilt marketing site (Tembo-style mega menu).
 *
 * Kortix is a wide product, so the Product menu is split by the question a
 * visitor is actually asking:
 *   Platform     — "what is this thing and where does it run?"
 *   Capabilities — "what can it actually do for me?"
 *
 * TODO(landing): several destinations below do not have dedicated pages yet and
 * currently point at /docs or the closest existing page. Build these out as
 * real sub-pages before this nav replaces the site-wide one:
 *   sessions & sandboxes, change requests, agents, skills, connectors,
 *   channels, triggers.
 */

export type NavItem = {
  label: string;
  description: string;
  href: string;
};

export type NavGroup = {
  heading: string;
  items: readonly NavItem[];
};

export const productMenu = {
  groups: [
    {
      heading: 'Platform',
      items: [
        {
          label: 'Command center',
          description: 'One place to run every project',
          href: '/landing#flow',
        },
        {
          label: 'Sessions & sandboxes',
          description: 'Each agent gets its own computer',
          href: '/docs',
        },
        {
          label: 'Change requests',
          description: 'Work lands as a reviewed merge',
          href: '/docs',
        },
        {
          label: 'Self-hosted',
          description: 'Run Kortix on your own infrastructure',
          href: '/docs',
        },
        {
          label: 'Enterprise',
          description: 'SSO, RBAC, audit trails, and on-prem',
          href: '/enterprise',
        },
      ],
    },
    {
      heading: 'Capabilities',
      items: [
        {
          label: 'Agents',
          description: 'Native harness agents, scoped by kortix.yaml',
          href: '/docs',
        },
        {
          label: 'Skills',
          description: 'Reusable know-how in every session',
          href: '/docs',
        },
        {
          label: 'Connectors',
          description: '3,000+ apps, plus MCP, OpenAPI, and HTTP',
          href: '/docs',
        },
        {
          label: 'Channels',
          description: 'Slack, Teams, WhatsApp, SMS, and email',
          href: '/docs',
        },
        {
          label: 'Triggers & schedules',
          description: 'Kick off work on a cron or a webhook',
          href: '/docs',
        },
        {
          label: 'Marketplace',
          description: 'Install a whole department in one click',
          href: '/marketplace',
        },
      ],
    },
  ],
  footer: {
    label: 'Kortix CLI',
    description: 'Drive the whole platform from your terminal',
    linkLabel: 'Read the docs',
    href: '/developers',
  },
} as const satisfies { groups: readonly NavGroup[]; footer: Record<string, string> };

export const companyMenu = {
  items: [
    { label: 'About', description: 'Our mission and the people behind Kortix', href: '/about' },
    { label: 'Blog', description: 'Guides, updates, and engineering notes', href: '/blog' },
    { label: 'Changelog', description: 'The latest product updates', href: '/changelog' },
    { label: 'Careers', description: 'Join the team building Kortix', href: '/careers' },
    { label: 'Contact', description: 'Talk to us about your rollout', href: '/contact' },
  ],
} as const satisfies { items: readonly NavItem[] };

/** Flat links that sit alongside the two mega menus. */
export const flatLinks = [
  { label: 'Use Cases', href: '/use-cases' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/docs' },
] as const;
