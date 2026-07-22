import markdownRoutes from '@/lib/seo/markdown-routes.json';

/**
 * Edge-safe: this module is imported by middleware and must never transitively
 * reach node:fs. That is why it reads the generated JSON map rather than
 * `@/lib/seo/public-content`.
 */
const ROUTES = markdownRoutes as Record<string, string>;

export const MARKDOWN_ROUTE_PATHS: string[] = Object.keys(ROUTES);

export function markdownRouteFor(pathname: string): string | undefined {
  return ROUTES[pathname];
}

type MediaRange = { type: string; q: number };

function parseAccept(header: string): MediaRange[] {
  return header
    .split(',')
    .map((part) => {
      const [rawType, ...params] = part.split(';').map((segment) => segment.trim());
      if (!rawType) return null;
      const qParam = params.find((param) => param.toLowerCase().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { type: rawType.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((range): range is MediaRange => range !== null);
}

function qualityFor(ranges: MediaRange[], mediaType: string): number {
  const group = mediaType.split('/')[0];
  let best = 0;
  for (const range of ranges) {
    if (range.type === mediaType || range.type === `${group}/*` || range.type === '*/*') {
      best = Math.max(best, range.q);
    }
  }
  return best;
}

/**
 * True only when the client ranks markdown strictly above HTML. A wildcard
 * (`*\/*` from curl, or a browser's `*\/*;q=0.8` tail) matches both equally and
 * therefore keeps HTML — HTML stays the default representation.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const markdown = qualityFor(ranges, 'text/markdown');
  if (markdown <= 0) return false;
  return markdown > qualityFor(ranges, 'text/html');
}
