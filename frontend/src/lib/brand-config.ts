/**
 * Brand Configuration for Adentic
 * This module defines the brand identity and configuration for the platform
 */

export interface BrandConfig {
  name: string;
  tagline?: string;
  primaryColor: string;
  copyrightText: string;
  social: {
    linkedin: string;
    twitter?: string;
    github?: string;
    facebook?: string;
  };
}

export const brandConfig: BrandConfig = {
  name: 'Adentic',
  tagline: 'AI Agent Platform',
  primaryColor: '#CC3A00',
  copyrightText: '© 2025 Adentic. All rights reserved.',
  social: {
    linkedin: 'https://www.linkedin.com/company/tryadentic',
    // Maintain existing social links if they exist
    twitter: process.env.NEXT_PUBLIC_TWITTER_URL,
    github: process.env.NEXT_PUBLIC_GITHUB_URL,
  },
};

// Export for API response
export const getBrandConfigAPI = () => ({
  name: brandConfig.name,
  primaryColor: brandConfig.primaryColor,
  copyrightText: brandConfig.copyrightText,
  social: brandConfig.social,
  assets: {
    logoUrl: '/logo.png',
    faviconUrl: '/favicon.ico',
    ogImageUrl: '/og-image.png',
    appleTouchIconUrl: '/apple-touch-icon.png',
  },
});

// Validation helpers
export const validateHexColor = (color: string): boolean => {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
};

export const validateBrandConfig = (config: Partial<BrandConfig>): boolean => {
  if (!config.name || config.name.trim().length === 0) {
    return false;
  }

  if (config.primaryColor && !validateHexColor(config.primaryColor)) {
    return false;
  }

  if (!config.copyrightText || config.copyrightText.trim().length === 0) {
    return false;
  }

  if (config.social?.linkedin && !config.social.linkedin.startsWith('http')) {
    return false;
  }

  return true;
};