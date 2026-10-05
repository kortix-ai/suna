/**
 * Pure logic behind the web-page tool renderers: `web-fetch-tool.tsx` and
 * `scrape-webpage-tool.tsx`.
 *
 * The HTML→text pipeline (`extractReadableHtml`) and the URL helpers
 * (`safeHttpUrl`, `prefersPreviewLink`) come from `@kortix/shared`
 * (`packages/shared/src/tools`, KRTX-365). Ported from apps/web and kept here:
 * - `tool/tools/web-fetch-tool.tsx` trigger + error summary;
 * - `tool/tools/scrape-webpage-tool.tsx` content cap and row keys (web computes
 *   a "N pages" badge but never draws it, so it is not ported).
 */

import { looksLikeHtml, type ScrapeResult } from '@kortix/sdk';

// ─── Web fetch ───────────────────────────────────────────────────────────────

/** Characters of readable text shown under a fetched page. */
export const WEB_FETCH_READABLE_CHARS = 4000;
/** Characters of raw HTML behind "View raw HTML". */
export const WEB_FETCH_RAW_HTML_CHARS = 8000;

/** The page's own title leads; its domain is the subtitle when they differ. */
export function webFetchTrigger({
  url,
  format,
  pageTitle,
  domain,
}: {
  url: string;
  format: string;
  pageTitle: string | undefined;
  domain: string;
}): { title: string; subtitle: string | undefined; args: string[] | undefined } {
  const title = pageTitle?.trim();
  const showDomainSubtitle = Boolean(title && title !== domain);
  return {
    title: title || domain || url,
    subtitle: showDomainSubtitle ? domain : undefined,
    args: format ? [format] : undefined,
  };
}

export function webFetchErrorSummary(output: string): string {
  return output.replace(/^Error:\s*/i, '').trim();
}

// ─── Scrape webpage ──────────────────────────────────────────────────────────

const MAX_SCRAPE_CONTENT_CHARS = 8000;

export function capScrapeContent(content: string): string {
  return content.length > MAX_SCRAPE_CONTENT_CHARS
    ? content.slice(0, MAX_SCRAPE_CONTENT_CHARS).trimEnd() + '…'
    : content;
}

export function getScrapeContent(result: ScrapeResult): { content: string; allowHtml?: boolean } {
  if (!result.success && result.error) return { content: result.error };
  const content = result.content?.trim();
  if (!content) return { content: 'No content extracted.' };
  const capped = capScrapeContent(content);
  if (looksLikeHtml(capped)) return { content: capped, allowHtml: true };
  return { content: capped };
}

/** Stable, unique row keys: a repeated URL gets `#n`. */
export function scrapeResultKeys(results: ScrapeResult[]): string[] {
  const seen = new Map<string, number>();
  return results.map((result) => {
    const n = seen.get(result.url) ?? 0;
    seen.set(result.url, n + 1);
    return n ? `${result.url}#${n}` : result.url;
  });
}
