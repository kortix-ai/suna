import { pricingTiers, type PricingTier } from '@/lib/pricing-config';

// Re-export for backward compatibility
export type { PricingTier } from '@/lib/pricing-config';

export const siteConfig = {
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  nav: {
    links: [
      { id: 1, name: 'Home', href: '/' },
      { id: 2, name: 'About', href: '/about' },
      { id: 3, name: 'Pricing', href: '/pricing' },
    ],
  },
  hero: {
    description:
      'SprintLab – open-source platform to build, manage and train your AI Workforce.',
  },
  cloudPricingItems: pricingTiers,
  footerLinks: [
    {
      title: 'SprintLab',
      links: [
        { id: 1, title: 'About', url: '/about' },
        { id: 2, title: 'Careers', url: '/careers' },
        { id: 3, title: 'Support', url: '/support' },
        { id: 4, title: 'Contact', url: 'mailto:hey@sprintlab.id' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 5, title: 'Documentation', url: 'https://github.com/sprintlab/suna' },
        { id: 6, title: 'Discord', url: 'https://discord.com/invite/RvFhXUdZ9H' },
        { id: 7, title: 'GitHub', url: 'https://github.com/sprintlab/suna' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { id: 8, title: 'Privacy Policy', url: '/legal?tab=privacy' },
        { id: 9, title: 'Terms of Service', url: '/legal?tab=terms' },
        { id: 10, title: 'License', url: 'https://github.com/sprintlab/suna/blob/main/LICENSE' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
