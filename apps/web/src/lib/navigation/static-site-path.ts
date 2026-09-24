/**
 * Paths this origin serves that are NOT App Router routes: the Blume (Astro)
 * docs build in `public/docs/` and the generated text/XML endpoints.
 *
 * A `next/link` to one of them is wrong twice over. In the viewport it
 * prefetches `<path>` with `RSC: 1`, which a static file cannot answer (prod
 * logged 404s for `/docs*` and `/sitemap.xml`). On click it tries a soft
 * navigation first, fails, and only then falls back to a document load. A
 * plain `<a>` does the document load directly.
 */
const STATIC_SITE_PATH = /^\/(?:docs(?:[/?#]|$)|(?:sitemap\.xml|robots\.txt|llms\.txt|llms-full\.txt)(?:[?#]|$))/;

export function isStaticSitePath(href: unknown): href is string {
  return typeof href === 'string' && STATIC_SITE_PATH.test(href);
}
