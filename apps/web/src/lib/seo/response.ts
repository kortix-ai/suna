import type { PublicContentRecord } from '@/lib/seo/public-content';
import { absoluteUrl } from '@/lib/seo/public-content';

export const MACHINE_CONTENT_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

export function markdownResponse(markdown: string, record: PublicContentRecord): Response {
  return new Response(markdown, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/plain; charset=utf-8',
      Link: `<${absoluteUrl(record.htmlPath)}>; rel="canonical"; type="text/html"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
