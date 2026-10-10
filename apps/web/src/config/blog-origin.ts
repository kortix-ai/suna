/**
 * Origin the /blog rewrites in next.config.ts proxy to. The blog is a separate
 * Next.js app (kortix-ai/marketing, basePath /blog) deployed for production.
 * An unset KORTIX_BLOG_ORIGIN falls back to the canonical origin, so /blog
 * serves the real blog on every deployment — the site's own navigation
 * advertises the route on all of them. An explicit empty value keeps /blog
 * unserved.
 */
export const DEFAULT_BLOG_ORIGIN = 'https://kortix.com';

export function resolveBlogOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return DEFAULT_BLOG_ORIGIN;
  return origin.replace(/\/+$/, '') || undefined;
}

export const BLOG_ORIGIN = resolveBlogOrigin(process.env.KORTIX_BLOG_ORIGIN);
