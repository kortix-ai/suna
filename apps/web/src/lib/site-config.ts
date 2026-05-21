export const siteConfig = {
  url: process.env.KORTIX_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000',
  nav: {
    links: [
      { id: 1, name: 'Home', href: '/' },
      { id: 2, name: 'Use cases', href: '/use-cases' },
      { id: 3, name: 'Technology', href: '/technology' },
    ],
  },
  hero: {
    description:
      'Kortix – the open AI command center for your company.',
  },
  footerLinks: [
    {
      title: 'Product',
      links: [
        { id: 14, title: 'Use cases', url: '/use-cases' },
        { id: 15, title: 'Technology', url: '/technology' },
        { id: 1, title: 'About', url: '/about' },
        { id: 2, title: 'Careers', url: '/careers' },
        { id: 4, title: 'Support', url: '/support' },
        { id: 5, title: 'Contact', url: 'mailto:hey@kortix.com' },
        { id: 13, title: 'Status', url: 'https://status.kortix.com' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 6, title: 'Tutorials', url: '/tutorials' },
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
