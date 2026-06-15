export const siteConfig = {
  url:
    process.env.KORTIX_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    'http://localhost:3000',
  nav: {
    links: [
      { id: 1, name: 'Product', href: '/' },
      { id: 2, name: 'Developers', href: '/developers' },
      { id: 3, name: 'Enterprise', href: '/enterprise' },
      { id: 4, name: 'Solutions', href: '/solutions' },
      { id: 5, name: 'Pricing', href: '/pricing' },
      { id: 6, name: 'Docs', href: '/docs' },
    ],
  },
  hero: {
    description: 'Kortix – the open AI command center for your company.',
  },
  footerLinks: [
    {
      title: 'Product',
      links: [
        { id: 1, title: 'Developers', url: '/developers' },
        { id: 2, title: 'Enterprise', url: '/enterprise' },
        { id: 3, title: 'Solutions', url: '/solutions' },
        { id: 4, title: 'Integrations', url: '/integrations' },
        { id: 5, title: 'Pricing', url: '/pricing' },
        { id: 6, title: 'Security', url: '/security' },
      ],
    },
    {
      title: 'Compare',
      links: [
        { id: 1, title: 'vs ChatGPT', url: '/compare/kortix-vs-chatgpt' },
        { id: 2, title: 'vs Zapier', url: '/compare/kortix-vs-zapier' },
        { id: 3, title: 'vs Claude in Slack', url: '/compare/kortix-vs-claude-in-slack' },
        { id: 4, title: 'All comparisons', url: '/compare' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 7, title: 'Documentation', url: '/docs' },
        { id: 14, title: 'Blog', url: '/blog' },
        { id: 15, title: 'Changelog', url: '/changelog' },
        { id: 8, title: 'Discord', url: 'https://discord.com/invite/RvFhXUdZ9H' },
        { id: 9, title: 'GitHub', url: 'https://github.com/kortix-ai/suna' },
        { id: 16, title: 'Support', url: '/support' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { id: 10, title: 'Privacy Policy', url: '/legal?tab=privacy' },
        { id: 11, title: 'Terms of Service', url: '/legal?tab=terms' },
        { id: 12, title: 'License', url: 'https://github.com/kortix-ai/suna/blob/main/LICENSE' },
        { id: 13, title: 'Status', url: 'https://status.kortix.com' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
