import { MetadataRoute } from 'next';
import { siteConfig } from '@/lib/site-config';
import { locales } from '@/i18n/config';
import { getAllPosts } from '@/lib/blog';

// Marketing pages that support locale routing for SEO
const MARKETING_ROUTES = [
  { path: '/', priority: 1, changeFrequency: 'daily' as const },
  { path: '/legal', priority: 0.5, changeFrequency: 'monthly' as const },
  { path: '/support', priority: 0.7, changeFrequency: 'weekly' as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = siteConfig.url;
  const sitemapEntries: MetadataRoute.Sitemap = [];

  // Generate entries for each marketing route in all locales
  MARKETING_ROUTES.forEach((route) => {
    locales.forEach((locale) => {
      const url = locale === 'en' 
        ? `${baseUrl}${route.path}` 
        : `${baseUrl}/${locale}${route.path}`;
      
      sitemapEntries.push({
        url,
        lastModified: new Date(),
        changeFrequency: route.changeFrequency,
        priority: route.priority,
        alternates: {
          languages: Object.fromEntries(
            locales.map((loc) => [
              loc,
              loc === 'en' ? `${baseUrl}${route.path}` : `${baseUrl}/${loc}${route.path}`
            ])
          ),
        },
      });
    });
  });

  // Blog index + posts (English only — the blog isn't locale-routed).
  sitemapEntries.push({
    url: `${baseUrl}/blog`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.8,
  });
  getAllPosts().forEach((post) => {
    sitemapEntries.push({
      url: `${baseUrl}${post.url}`,
      lastModified: new Date(`${post.data.date}T00:00:00Z`),
      changeFrequency: 'monthly',
      priority: 0.7,
    });
  });

  return sitemapEntries;
}

