/**
 * Consolidation — turning many pages into one prompt that fits.
 *
 * Extraction gets a single call, so everything the model will ever see about
 * this company has to fit in one context window. That makes this a budgeting
 * problem: which text earns its tokens.
 *
 * The ordering reflects how much each kind of input is worth per character.
 * Structured data (JSON-LD, OpenGraph) comes first and is never trimmed — it
 * is the site's own machine-readable claims about itself, dense and unambiguous,
 * and it costs almost nothing. Priority pages come next with their content
 * truncated per page, since a company's story is told in the first screens of
 * /about and /pricing, not the twentieth. Blog posts contribute a title and URL
 * each: enough to index what the company publishes, without paying for prose
 * that says little about the company itself.
 *
 * When the budget still binds, the lowest-value material is dropped first and
 * the omission is stated in the prompt, so the model knows its view is partial
 * rather than silently treating a truncated corpus as the whole site.
 */
import type { StructuredSignals } from './discovery';
import type { UrlTier } from './url-filter';

/** ~4 characters per token is close enough for budgeting and needs no tokenizer. */
const CHARS_PER_TOKEN = 4;
export const DEFAULT_TOKEN_BUDGET = 60_000;
export const DEFAULT_PER_PAGE_CHARS = 15_000;

export interface ConsolidatePage {
  url: string;
  markdown: string;
  tier: UrlTier;
}

export interface ConsolidateOptions {
  tokenBudget?: number;
  perPageChars?: number;
}

export interface ConsolidateResult {
  text: string;
  includedUrls: string[];
  omittedUrls: string[];
  approxTokens: number;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Cut at a paragraph break when one is nearby so the model never sees a
  // sentence sliced mid-word.
  const window = text.slice(0, limit);
  const lastBreak = window.lastIndexOf('\n\n');
  const cut = lastBreak > limit * 0.6 ? window.slice(0, lastBreak) : window;
  return { text: cut, truncated: true };
}

/** First markdown heading, falling back to the first non-empty line. */
export function titleOf(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^#{1,3}\s+(.*)$/);
    if (heading) return heading[1].trim() || null;
    return trimmed.slice(0, 200);
  }
  return null;
}

function renderSignals(domain: string, signals: StructuredSignals): string {
  const lines: string[] = [`# Site: ${domain}`, ''];

  if (signals.title) lines.push(`Page title: ${signals.title}`);
  const og = Object.entries(signals.openGraph);
  if (og.length > 0) {
    lines.push('', 'OpenGraph tags:');
    for (const [key, value] of og) lines.push(`- og:${key}: ${value}`);
  }
  const description = signals.meta.description;
  if (description) lines.push('', `Meta description: ${description}`);

  if (signals.jsonLd.length > 0) {
    lines.push(
      '',
      'TRUSTED structured data (schema.org, published by the site itself — prefer this over prose when they disagree):',
      '```json',
      JSON.stringify(signals.jsonLd, null, 1).slice(0, 20_000),
      '```',
    );
  }

  return lines.join('\n');
}

function renderPage(page: ConsolidatePage, perPageChars: number): string {
  const { text, truncated } = truncate(page.markdown.trim(), perPageChars);
  return [
    `## Page: ${page.url}`,
    '',
    text,
    truncated ? '\n[content truncated]' : '',
  ].join('\n');
}

/**
 * Build the extraction input. Returns the prompt text plus which URLs made it
 * in, so the job can record what the profile was actually derived from.
 */
export function consolidate(
  domain: string,
  pages: ConsolidatePage[],
  signals: StructuredSignals,
  opts: ConsolidateOptions = {},
): ConsolidateResult {
  const budget = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
  const perPageChars = opts.perPageChars ?? DEFAULT_PER_PAGE_CHARS;

  const header = renderSignals(domain, signals);
  const sections: string[] = [header];
  let used = header.length;

  const includedUrls: string[] = [];
  const omittedUrls: string[] = [];

  const contentPages = pages.filter((p) => p.tier !== 'blog');
  const blogPages = pages.filter((p) => p.tier === 'blog');

  for (const page of contentPages) {
    const rendered = renderPage(page, perPageChars);
    if (used + rendered.length > budget) {
      omittedUrls.push(page.url);
      continue;
    }
    sections.push(rendered);
    used += rendered.length;
    includedUrls.push(page.url);
  }

  if (blogPages.length > 0) {
    const entries: string[] = [];
    for (const page of blogPages) {
      const title = titleOf(page.markdown);
      const line = `- ${title ?? '(untitled)'} — ${page.url}`;
      if (used + line.length > budget) {
        omittedUrls.push(page.url);
        continue;
      }
      entries.push(line);
      used += line.length;
      includedUrls.push(page.url);
    }
    if (entries.length > 0) {
      const block = ['## Blog index (titles and links only)', '', ...entries].join('\n');
      sections.push(block);
    }
  }

  if (omittedUrls.length > 0) {
    sections.push(
      `\n[${omittedUrls.length} further page(s) were not included because the input limit was reached. Do not guess at their contents.]`,
    );
  }

  const text = sections.join('\n\n');
  return {
    text,
    includedUrls,
    omittedUrls,
    approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}
