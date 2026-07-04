import { recoverLinkResults } from '@/features/session/tool/tool-output-format';
export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  author?: string;
  publishedDate?: string;
}

export interface WebSearchQueryResult {
  query: string;
  answer?: string;
  sources: WebSearchSource[];
}

export function parseWebSearchOutput(output: string | any): WebSearchQueryResult[] {
  if (!output) return [];

  let parsed: any = null;
  if (typeof output === 'object' && output !== null) {
    parsed = output;
  } else if (typeof output === 'string') {
    try {
      let result = JSON.parse(output);

      if (typeof result === 'string') {
        try {
          result = JSON.parse(result);
        } catch {}
      }
      parsed = typeof result === 'object' ? result : null;
    } catch {
      const trimmed = output.trim().replace(/^\uFEFF/, '');
      if (trimmed !== output) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {}
      }
    }
  }

  if (parsed) {
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      const firstItem = parsed.results[0];
      if (firstItem && typeof firstItem.query === 'string') {
        const queryResults: WebSearchQueryResult[] = [];
        for (const r of parsed.results) {
          if (typeof r.query !== 'string') continue;
          const sources: WebSearchSource[] = [];
          if (Array.isArray(r.results)) {
            for (const s of r.results) {
              if (s.title && s.url) {
                sources.push({
                  title: s.title,
                  url: s.url,
                  snippet: s.snippet || s.content || s.text || undefined,
                  author: s.author || undefined,
                  publishedDate: s.publishedDate || s.published_date || undefined,
                });
              }
            }
          }
          queryResults.push({
            query: r.query,
            answer: r.answer || undefined,
            sources,
          });
        }
        if (queryResults.length > 0) return queryResults;
      } else if (firstItem && (firstItem.title || firstItem.url)) {
        const sources: WebSearchSource[] = [];
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title,
              url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
              publishedDate: s.publishedDate || s.published_date || undefined,
            });
          }
        }
        if (sources.length > 0) {
          return [
            {
              query: parsed.query || '',
              answer: parsed.answer || undefined,
              sources,
            },
          ];
        }
      }
    }

    if (parsed.query && typeof parsed.query === 'string') {
      const sources: WebSearchSource[] = [];
      if (Array.isArray(parsed.results)) {
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title,
              url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
              publishedDate: s.publishedDate || s.published_date || undefined,
            });
          }
        }
      }
      return [{ query: parsed.query, answer: parsed.answer || undefined, sources }];
    }

    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed[0] &&
      (parsed[0].title || parsed[0].url)
    ) {
      const sources: WebSearchSource[] = [];
      for (const s of parsed) {
        if (s.title && s.url) {
          sources.push({
            title: s.title,
            url: s.url,
            snippet: s.snippet || s.content || s.text || undefined,
            author: s.author || undefined,
            publishedDate: s.publishedDate || s.published_date || undefined,
          });
        }
      }
      if (sources.length > 0) return [{ query: '', sources }];
    }
  }

  if (typeof output === 'string') {
    const blocks = output.split(/(?=^Title: )/m).filter(Boolean);
    const sources: WebSearchSource[] = [];
    for (const block of blocks) {
      const titleMatch = block.match(/^Title:\s*(.+)/m);
      const urlMatch = block.match(/^URL:\s*(.+)/m);
      const authorMatch = block.match(/^Author:\s*(.+)/m);
      const dateMatch = block.match(/^Published Date:\s*(.+)/m);
      const textMatch = block.match(/^Text:\s*([\s\S]*?)$/m);
      if (titleMatch && urlMatch) {
        sources.push({
          title: titleMatch[1].trim(),
          url: urlMatch[1].trim(),
          snippet: textMatch?.[1]?.trim() || undefined,
          author: authorMatch?.[1]?.trim() || undefined,
          publishedDate: dateMatch?.[1]?.trim() || undefined,
        });
      }
    }
    if (sources.length > 0) return [{ query: '', sources }];
  }

  if (typeof output === 'string') {
    const recovered = recoverLinkResults(output);
    if (recovered.length > 0) {
      return [
        {
          query: '',
          sources: recovered.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
        },
      ];
    }
  }
  return [];
}

export function wsDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/** Registrable domain for grouping subdomains (e.g. photos.google.com → google.com). */
export function wsRootDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    return parts.slice(-2).join('.');
  } catch {
    return wsDomain(url);
  }
}

export { faviconUrlForUrl as wsFavicon } from '@/lib/favicon';

export interface ScrapeResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  error?: string;
}

export interface ParsedScrapeOutput {
  total: number;
  successful: number;
  failed: number;
  results: ScrapeResult[];
}

export function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  const head = s.slice(0, 600).toLowerCase();
  if (head.includes('<!doctype html') || head.includes('<html')) return true;
  return /<\/(body|head|div|p|span|table)>/i.test(s.slice(0, 3000));
}

/** URLs from scrape_webpage input (`urls` string or array). */
export function parseScrapeInputUrls(input: Record<string, unknown>): string[] {
  const raw = input.urls ?? input.url;
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((u) => /^https?:\/\//i.test(u));
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((u): u is string => typeof u === 'string')
      .map((s) => s.trim())
      .filter((u) => /^https?:\/\//i.test(u));
  }
  return [];
}

/** Build per-URL failure cards when the tool returns a plain error string. */
export function buildScrapeFailureResults(output: string, urls: string[]): ScrapeResult[] {
  if (urls.length === 0) return [];
  const cleaned = output.replace(/^Error:\s*/i, '').trim();

  return urls.map((url) => {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const perUrl = new RegExp(`${escaped}\\s*:\\s*([^]*?)(?=\\s+https?:\\/\\/|$)`, 'i');
    const match = cleaned.match(perUrl);
    const error = match?.[1]?.trim() || cleaned;
    return { url, success: false, error };
  });
}

/** Parsed scrape results, or per-input-URL failure cards for plain error output. */
export function resolveScrapeResults(
  output: string | unknown,
  input: Record<string, unknown>,
): ScrapeResult[] {
  const parsed = parseScrapeOutput(output);
  if (parsed?.results?.length) return parsed.results;

  const outputStr = typeof output === 'string' ? output : '';
  if (!outputStr.trim()) return [];

  return buildScrapeFailureResults(outputStr, parseScrapeInputUrls(input));
}

export function parseScrapeOutput(output: string | any): ParsedScrapeOutput | null {
  if (!output) return null;
  let parsed: any = null;
  if (typeof output === 'object' && output !== null) {
    parsed = output;
  } else if (typeof output === 'string') {
    try {
      let result = JSON.parse(output);
      if (typeof result === 'string') {
        try {
          result = JSON.parse(result);
        } catch {}
      }
      parsed = typeof result === 'object' ? result : null;
    } catch {}
  }
  if (!parsed) return null;

  if (parsed.results && Array.isArray(parsed.results)) {
    return {
      total: parsed.total || parsed.results.length,
      successful:
        parsed.successful ?? parsed.results.filter((r: any) => r.success !== false).length,
      failed: parsed.failed ?? parsed.results.filter((r: any) => r.success === false).length,
      results: parsed.results.map((r: any) => ({
        url: r.url || '',
        success: r.success !== false,
        title: r.title || undefined,
        content: r.content || r.text || r.snippet || undefined,
        error: r.error || undefined,
      })),
    };
  }

  if (typeof output === 'string') {
    const recovered = recoverLinkResults(output);
    if (recovered.length > 0) {
      return {
        total: recovered.length,
        successful: recovered.length,
        failed: 0,
        results: recovered.map((r) => ({
          url: r.url,
          success: true,
          title: r.title || undefined,
          content: r.snippet || undefined,
        })),
      };
    }
  }
  return null;
}
