/**
 * Page summarization — the map half of map/reduce extraction.
 *
 * A single reduce call over up to 40 pages forced every page to a 15k-char
 * truncation and reduced blog posts to a title and a link, because everything
 * had to fit in one prompt. Giving every long page its own small model call
 * first — a compact digest instead of clipped raw text — lets the reduce pass
 * see the substance of all 40 pages instead of the first screen of the first
 * dozen.
 *
 * Only pages long enough to actually lose content to that old truncation pay
 * for a call: a page under `PAGE_SUMMARY_THRESHOLD` already fits the reduce
 * prompt whole, so mapping it would just be a second round trip for a result
 * no more complete than the raw text already is. Concurrency is capped so one
 * site with 40 long pages does not open 40 simultaneous completions, and a
 * failed map call degrades to a truncated excerpt of that one page rather than
 * failing the job — a flaky call on one page is not a reason to lose the other
 * 39.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { parseJsonLoose, type ChatFn, type ChatMessage } from './chat-json';
import { DEFAULT_PER_PAGE_CHARS, truncate, type ConsolidatePage } from './consolidate';

/** Pages at or under this length already fit the reduce prompt whole. */
export const PAGE_SUMMARY_THRESHOLD = 4_000;
export const MAP_CONCURRENCY = 4;

/**
 * The 1 MB fetch cap (`MAX_PAGE_BYTES` in `page-fetch.ts`) means a single
 * pathological page can otherwise land ~250k tokens of raw markdown on one map
 * call. Every other stage bounds its input the same way — `consolidate`'s
 * per-page truncation, the map pass's own degraded-excerpt fallback — and a
 * one-page summary needs far less than either: it is asked for a digest, not
 * the reduce pass's full context, so this stays generous rather than tight.
 */
export const MAP_INPUT_MAX_CHARS = 24_000;

export const PageKindSchema = z.enum([
  'home',
  'about',
  'pricing',
  'product',
  'blog',
  'careers',
  'contact',
  'other',
]);
export type PageKind = z.infer<typeof PageKindSchema>;

export const PageSummarySchema = z.object({
  url: z.string().trim().min(1),
  pageKind: PageKindSchema,
  purpose: z.string().trim(),
  keyPoints: z.array(z.string().trim()).default([]),
  entities: z.array(z.string().trim()).default([]),
  pricingTiers: z.array(z.string().trim()).default([]),
  quotes: z.array(z.string().trim()).default([]),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export type MappedPage =
  | { url: string; kind: 'summary'; summary: PageSummary }
  | { url: string; kind: 'excerpt'; markdown: string; degraded: boolean };

const MAP_SYSTEM_PROMPT = [
  'You summarize a single page from a company or personal website so another',
  'model can build a full profile later without re-reading the raw page.',
  '',
  'Rules:',
  '- Respond with a single JSON object and nothing else. No prose, no markdown fences.',
  '- "pageKind" is your best read of what this page is: home, about, pricing, product,',
  '  blog, careers, contact, or other.',
  '- "purpose" is one sentence describing what the page is for.',
  '- "keyPoints" are the concrete, checkable facts worth keeping — claims, features,',
  '  numbers, names — not filler or navigation text.',
  '- "entities" are named people, products, companies or technologies the page mentions.',
  '- "pricingTiers" lists plan names or price points only if the page actually states',
  '  pricing; otherwise leave it empty.',
  '- "quotes" holds short verbatim phrases worth preserving in the subject\'s own words',
  '  (a tagline, a testimonial, a notable sentence).',
  '- Never invent something the page does not say. An empty array is correct when a',
  '  section has nothing to report.',
].join('\n');

function buildPageSummaryJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(PageSummarySchema, {
    name: 'page_summary',
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

export interface SummarizePageOptions {
  chat: ChatFn;
  model: string;
  signal?: AbortSignal;
}

/**
 * One map call for one page. Throws on any transport, JSON, or schema failure
 * — by design, callers (`mapPages`) treat that as the signal to degrade this
 * one page to an excerpt rather than retrying or failing the job. The page
 * text is capped at `MAP_INPUT_MAX_CHARS` first — silently, since a truncated
 * page still deserves a summary rather than being skipped or failed outright.
 */
export async function summarizePage(
  page: ConsolidatePage,
  opts: SummarizePageOptions,
): Promise<PageSummary> {
  const jsonSchema = buildPageSummaryJsonSchema();
  const { text } = truncate(page.markdown.trim(), MAP_INPUT_MAX_CHARS);
  const messages: ChatMessage[] = [
    { role: 'system', content: MAP_SYSTEM_PROMPT },
    { role: 'user', content: `Page URL: ${page.url}\n\n${text}` },
  ];
  const raw = await opts.chat({ messages, model: opts.model, jsonSchema, signal: opts.signal });
  const parsed = parseJsonLoose(raw);
  // The model is asked to echo the URL but is untrusted on it like everything
  // else it returns; the page it was actually shown is the only URL that can
  // be correct here, so it overrides whatever the model wrote.
  return PageSummarySchema.parse({ ...(parsed as Record<string, unknown>), url: page.url });
}

export interface MapPagesOptions {
  chat: ChatFn;
  model: string;
  signal?: AbortSignal;
  threshold?: number;
  concurrency?: number;
  excerptChars?: number;
}

export interface MapPagesResult {
  /** One entry per input page, in input order regardless of completion order. */
  mapped: MappedPage[];
  summarizedCount: number;
  failedCount: number;
}

/**
 * Map every page to either a structured summary or a raw excerpt, at most
 * `concurrency` calls in flight at once. A shared cursor across a fixed pool
 * of workers gives bounded concurrency without pulling in a queue dependency,
 * and writing each result to its input index keeps output order stable no
 * matter which call finishes first.
 */
export async function mapPages(
  pages: ConsolidatePage[],
  opts: MapPagesOptions,
): Promise<MapPagesResult> {
  const threshold = opts.threshold ?? PAGE_SUMMARY_THRESHOLD;
  const excerptChars = opts.excerptChars ?? DEFAULT_PER_PAGE_CHARS;
  const concurrency = Math.max(1, opts.concurrency ?? MAP_CONCURRENCY);

  const mapped: MappedPage[] = new Array(pages.length);
  let summarizedCount = 0;
  let failedCount = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pages.length) return;

      const page = pages[index];
      const trimmed = page.markdown.trim();

      if (trimmed.length <= threshold) {
        mapped[index] = { url: page.url, kind: 'excerpt', markdown: trimmed, degraded: false };
        continue;
      }

      try {
        const summary = await summarizePage(page, {
          chat: opts.chat,
          model: opts.model,
          signal: opts.signal,
        });
        mapped[index] = { url: page.url, kind: 'summary', summary };
        summarizedCount += 1;
      } catch {
        mapped[index] = {
          url: page.url,
          kind: 'excerpt',
          markdown: truncate(trimmed, excerptChars).text,
          degraded: true,
        };
        failedCount += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()));

  return { mapped, summarizedCount, failedCount };
}

/** Render one mapped page for the reduce prompt. */
export function renderMappedPage(page: MappedPage): string {
  if (page.kind === 'excerpt') {
    const note = page.degraded
      ? '\n[page summary unavailable — raw excerpt shown instead]'
      : '';
    return [`## Page: ${page.url}`, '', page.markdown, note].join('\n');
  }

  const { summary } = page;
  const lines = [
    `## Page: ${page.url} (summarized)`,
    '',
    `Kind: ${summary.pageKind}`,
    `Purpose: ${summary.purpose}`,
  ];
  if (summary.keyPoints.length > 0) {
    lines.push('Key points:', ...summary.keyPoints.map((point) => `- ${point}`));
  }
  if (summary.entities.length > 0) {
    lines.push(`Entities: ${summary.entities.join(', ')}`);
  }
  if (summary.pricingTiers.length > 0) {
    lines.push(`Pricing tiers mentioned: ${summary.pricingTiers.join(', ')}`);
  }
  if (summary.quotes.length > 0) {
    lines.push('Quotes:', ...summary.quotes.map((quote) => `- "${quote}"`));
  }
  return lines.join('\n');
}
