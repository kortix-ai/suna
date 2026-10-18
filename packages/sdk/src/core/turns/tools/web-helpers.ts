import { urlError } from '../text-scan';
import { recoverLinkResults } from './tool-output-format';

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

/** The JSON shapes the web tools return: an object, or an array of them. */
type ParsedJson = Record<string, unknown> | Record<string, unknown>[];

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonOutput(output: unknown, trimBom = false): ParsedJson | null {
  if (typeof output === 'object' && output !== null) return output as ParsedJson;
  if (typeof output !== 'string') return null;
  try {
    let result: unknown = JSON.parse(output);
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {}
    }
    return typeof result === 'object' ? (result as ParsedJson) : null;
  } catch {
    const trimmed = trimBom && output.trim().replace(/^\uFEFF/, '');
    if (trimmed && trimmed !== output) {
      try {
        const retried: unknown = JSON.parse(trimmed);
        return typeof retried === 'object' && retried !== null ? (retried as ParsedJson) : null;
      } catch {}
    }
    return null;
  }
}

function collectSources(list: unknown[]): WebSearchSource[] {
  return list
    .filter((s): s is Record<string, unknown> => isJsonRecord(s) && Boolean(s.title) && Boolean(s.url))
    .map((s) => ({
      title: s.title as string,
      url: s.url as string,
      snippet: (s.snippet || s.content || s.text || undefined) as string | undefined,
      author: (s.author || undefined) as string | undefined,
      publishedDate: (s.publishedDate || s.published_date || undefined) as string | undefined,
    }));
}

export function parseWebSearchOutput(output: unknown): WebSearchQueryResult[] {
  if (!output) return [];
  const parsed = parseJsonOutput(output, true);
  const record = parsed && !Array.isArray(parsed) ? parsed : undefined;
  if (record?.success === false) return [];
  const results = record && Array.isArray(record.results) ? (record.results as unknown[]) : undefined;
  if (results && results.length > 0) {
    const firstItem = results[0];
    if (isJsonRecord(firstItem) && typeof firstItem.query === 'string') {
      const queries: WebSearchQueryResult[] = [];
      for (const r of results) {
        if (!isJsonRecord(r) || typeof r.query !== 'string') continue;
        queries.push({
          query: r.query,
          answer: (r.answer || undefined) as string | undefined,
          sources: Array.isArray(r.results) ? collectSources(r.results) : [],
        });
      }
      if (queries.length > 0) return queries;
    } else if (isJsonRecord(firstItem) && (firstItem.title || firstItem.url)) {
      const sources = collectSources(results);
      if (sources.length > 0)
        return [
          {
            query: (record?.query || '') as string,
            answer: (record?.answer || undefined) as string | undefined,
            sources,
          },
        ];
    }
  }
  if (record?.query && typeof record.query === 'string') {
    return [
      {
        query: record.query,
        answer: (record.answer || undefined) as string | undefined,
        sources: results ? collectSources(results) : [],
      },
    ];
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0];
    if (isJsonRecord(first) && (first.title || first.url)) {
      const sources = collectSources(parsed);
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
    if (recovered.length > 0) return [{ query: '', sources: recovered.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })) }];
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

/** A page URL → its favicon, via Google's favicon service; `null` for a non-URL. */
export function wsFavicon(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
  } catch {
    return null;
  }
}

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
    const urls: string[] = [];
    for (const u of raw) {
      if (typeof u !== 'string') continue;
      const trimmed = u.trim();
      if (/^https?:\/\//i.test(trimmed)) urls.push(trimmed);
    }
    return urls;
  }
  return [];
}

/** Build per-URL failure cards when the tool returns a plain error string. */
export function buildScrapeFailureResults(
  output: string,
  urls: string[],
): ScrapeResult[] {
  if (urls.length === 0) return [];
  const cleaned = output.replace(/^Error:\s*/i, '').trim();

  return urls.map((url) => {
    const error = urlError(cleaned, url)?.trim() || cleaned;
    return { url, success: false, error };
  });
}

/** Parsed scrape results, or per-input-URL failure cards for plain error output. */
export function resolveScrapeResults(
  output: unknown,
  input: Record<string, unknown>,
): ScrapeResult[] {
  const parsed = parseScrapeOutput(output);
  if (parsed?.results?.length) return parsed.results;

  const outputStr = typeof output === 'string' ? output : '';
  if (!outputStr.trim()) return [];

  return buildScrapeFailureResults(outputStr, parseScrapeInputUrls(input));
}

export function parseScrapeOutput(output: unknown): ParsedScrapeOutput | null {
  if (!output) return null;
  const parsed = parseJsonOutput(output);
  const record = parsed && !Array.isArray(parsed) ? parsed : undefined;
  if (!record) return null;

  if (record.results && Array.isArray(record.results)) {
    const results = record.results as unknown[];
    return {
      total: (record.total || results.length) as number,
      successful:
        (record.successful as number | undefined) ??
        results.filter((r) => isJsonRecord(r) && r.success !== false).length,
      failed:
        (record.failed as number | undefined) ??
        results.filter((r) => isJsonRecord(r) && r.success === false).length,
      results: results.map((r) => {
        const item = isJsonRecord(r) ? r : {};
        return {
          url: (item.url || '') as string,
          success: item.success !== false,
          title: (item.title || undefined) as string | undefined,
          content: (item.content || item.text || item.snippet || undefined) as string | undefined,
          error: (item.error || undefined) as string | undefined,
        };
      }),
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
