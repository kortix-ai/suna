import type { PublicContentRecord } from '@/lib/seo/public-content';
import { absoluteUrl } from '@/lib/seo/public-content';

export const MACHINE_CONTENT_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

/**
 * A context-budget hint for agents, not an exact count. Real tokenisation is
 * model-specific; shipping a tokeniser to compute an advisory header is not
 * worth the bundle cost.
 */
export function estimateMarkdownTokens(markdown: string): number {
  return Math.ceil(markdown.length / 4);
}

export function markdownResponse(markdown: string, record: PublicContentRecord): Response {
  return new Response(markdown, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${absoluteUrl(record.htmlPath)}>; rel="canonical"; type="text/html"`,
      // This body is reachable both directly and by negotiating on the HTML
      // path, so caches must key on Accept.
      Vary: 'Accept',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
      'x-markdown-tokens': String(estimateMarkdownTokens(markdown)),
    },
  });
}
