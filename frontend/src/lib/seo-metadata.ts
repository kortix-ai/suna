/**
 * SEO Metadata Service for Adentic
 * This module generates SEO metadata for Next.js pages
 */

import { Metadata } from 'next';
import { brandConfig } from './brand-config';
import { brandAssets } from './brand-assets';

interface MetadataOptions {
  title?: string;
  description?: string;
  path?: string;
  ogType?: 'website' | 'article' | 'profile';
  keywords?: string[];
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
}

const defaultDescription = 'Adentic - Open-source platform for building, managing, and training AI agents.';
const defaultKeywords = [
  'AI agents',
  'artificial intelligence',
  'agent platform',
  'AI development',
  'machine learning',
  'Adentic',
];

export const generateMetadata = (options: MetadataOptions = {}): Metadata => {
  const {
    title,
    description = defaultDescription,
    path = '',
    ogType = 'website',
    keywords = defaultKeywords,
    author,
    publishedTime,
    modifiedTime,
  } = options;

  const fullTitle = title
    ? `${title} | ${brandConfig.name}`
    : `${brandConfig.name} - AI Agent Platform`;

  const url = process.env.NEXT_PUBLIC_URL
    ? `${process.env.NEXT_PUBLIC_URL}${path}`
    : `https://adentic.com${path}`;

  const metadata: Metadata = {
    title: fullTitle,
    description,
    keywords: keywords.join(', '),
    authors: author ? [{ name: author }] : [{ name: brandConfig.name }],

    metadataBase: new URL(process.env.NEXT_PUBLIC_URL || 'https://adentic.com'),

    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: brandConfig.name,
      type: ogType,
      images: [
        {
          url: brandAssets.openGraph.image,
          width: brandAssets.openGraph.width,
          height: brandAssets.openGraph.height,
          alt: `${brandConfig.name} - AI Agent Platform`,
        },
      ],
      locale: 'en_US',
    },

    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [brandAssets.openGraph.image],
      creator: '@adentic',
      site: '@adentic',
    },

    icons: {
      icon: [
        { url: brandAssets.logo.favicon, type: 'image/x-icon' },
        { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: [
        { url: brandAssets.logo.appleTouchIcon, sizes: '180x180' },
      ],
    },

    manifest: '/site.webmanifest',

    themeColor: [
      { media: '(prefers-color-scheme: light)', color: brandAssets.colors.primary },
      { media: '(prefers-color-scheme: dark)', color: brandAssets.colors.primary },
    ],

    viewport: {
      width: 'device-width',
      initialScale: 1,
      maximumScale: 5,
    },

    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },

    alternates: {
      canonical: url,
    },
  };

  // Add article-specific metadata if type is article
  if (ogType === 'article' && (publishedTime || modifiedTime || author)) {
    metadata.openGraph = {
      ...metadata.openGraph,
      type: 'article',
      publishedTime,
      modifiedTime,
      authors: author ? [author] : undefined,
    } as any;
  }

  return metadata;
};

// Generate structured data for rich snippets
export const generateStructuredData = (type: 'Organization' | 'WebSite' | 'SoftwareApplication' = 'Organization') => {
  const baseData = {
    '@context': 'https://schema.org',
    '@type': type,
    name: brandConfig.name,
    url: process.env.NEXT_PUBLIC_URL || 'https://adentic.com',
    logo: `${process.env.NEXT_PUBLIC_URL || 'https://adentic.com'}${brandAssets.logo.primary}`,
    description: defaultDescription,
  };

  if (type === 'Organization') {
    return {
      ...baseData,
      sameAs: [
        brandConfig.social.linkedin,
        brandConfig.social.twitter,
        brandConfig.social.github,
      ].filter(Boolean),
    };
  }

  if (type === 'SoftwareApplication') {
    return {
      ...baseData,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Cross-platform',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
    };
  }

  return baseData;
};