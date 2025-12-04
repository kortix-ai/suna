import { pricingTiers, type PricingTier } from '@/lib/pricing-config';

// Re-export for backward compatibility
export type { PricingTier } from '@/lib/pricing-config';

export const siteConfig = {
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  nav: {
    links: [
      { id: 1, name: 'Home', href: '#hero' },
      { id: 2, name: 'Process', href: '#process' },
      { id: 4, name: 'Open Source', href: '#open-source' },
      { id: 5, name: 'Pricing', href: '#pricing' },
      { id: 6, name: 'Enterprise', href: '/enterprise' },
    ],
  },
  hero: {
    description:
      'Kortix – open-source platform to build, manage and train your AI Workforce.',
  },
  cloudPricingItems: pricingTiers,
  footerLinks: [
    {
      title: 'Kortix',
      links: [
        { id: 1, title: 'About', url: 'https://www.kortix.com' },
        { id: 3, title: 'Contact', url: 'mailto:hey@kortix.com' },
        { id: 4, title: 'Careers', url: 'https://www.kortix.com/careers' },
      ],
    },
    {
      title: 'Resources',
      links: [
        {
          id: 5,
          title: 'Documentation',
          url: 'https://github.com/kortix-ai/suna',
        },
        { id: 7, title: 'Discord', url: 'https://discord.gg/Py6pCBUUPw' },
        { id: 8, title: 'GitHub', url: 'https://github.com/kortix-ai/suna' },
      ],
    },
    {
      title: 'Legal',
      links: [
        {
          id: 9,
          title: 'Privacy Policy',
          url: 'https://www.kortix.com/legal?tab=privacy',
        },
        {
          id: 10,
          title: 'Terms of Service',
          url: 'https://www.kortix.com/legal?tab=terms',
        },
        {
          id: 11,
          title: 'License',
          url: 'https://github.com/kortix-ai/suna/blob/main/LICENSE',
        },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
