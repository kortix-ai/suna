import { pricingTiers, type PricingTier } from '@/lib/pricing-config';

// Re-export for backward compatibility
export type { PricingTier } from '@/lib/pricing-config';

export const siteConfig = {
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  nav: {
    links: [
      { id: 1, name: 'Home', href: '#hero' },
      { id: 2, name: 'Process', href: '#process' },
      { id: 5, name: 'Pricing', href: '#pricing' },
      { id: 6, name: 'Enterprise', href: '/enterprise' },
    ],
  },
  hero: {
    description:
      'Xera – platform to build, manage and train your AI Workforce.',
  },
  cloudPricingItems: pricingTiers,
  footerLinks: [
    {
      title: 'Xera',
      links: [
        { id: 1, title: 'About', url: 'https://www.xera.cc' },
        { id: 3, title: 'Contact', url: 'mailto:hey@xera.cc' },
        { id: 4, title: 'Careers', url: 'https://www.xera.cc/careers' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 7, title: 'Discord', url: 'https://discord.gg/Py6pCBUUPw' },
      ],
    },
    {
      title: 'Legal',
      links: [
        {
          id: 9,
          title: 'Privacy Policy',
          url: 'https://www.xera.cc/legal?tab=privacy',
        },
        {
          id: 10,
          title: 'Terms of Service',
          url: 'https://www.xera.cc/legal?tab=terms',
        },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
