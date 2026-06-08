export const siteConfig = {
  url:
    process.env.KORTIX_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    'http://localhost:3000',
  nav: {
    links: [
      { id: 4, name: 'Enterprise', href: '/enterprise' },
      { id: 6, name: 'Pricing', href: '/pricing' },
    ],
  },
  hero: {
    description: 'Kortix – the open AI command center for your company.',
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
        { id: 11, title: 'Terms of Service', url: '/legal?tab=terms' },
        { id: 12, title: 'License', url: 'https://github.com/kortix-ai/suna/blob/main/LICENSE' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
