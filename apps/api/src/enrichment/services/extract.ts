/**
 * Extraction — the one step that turns pages into a profile.
 *
 * The model is treated as untrusted. It is asked for JSON against a schema and
 * it is given every chance to comply, but nothing it returns is stored until
 * Zod accepts it. When validation fails the errors are handed back verbatim
 * and the model is asked to fix its own output; that repair loop is bounded,
 * and a job that exhausts it fails as `extraction_failed` with the raw crawl
 * preserved. A missing profile is recoverable — a confidently wrong one that
 * lands in company memory is not.
 *
 * Two guards matter more than the prompt wording. First, `sources` is required
 * and non-empty, so an answer with no citations cannot validate. Second, the
 * caller passes only text it actually fetched, so "do not invent" is enforced
 * by what the model can see rather than by asking politely.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EnrichmentError } from '../errors';
import { ContactSchema, SocialLinkSchema, CompanyProfileSchema, type CompanyProfile } from '../schemas';
import { parseJsonLoose, type ChatFn, type ChatMessage } from './chat-json';
import { CHARS_PER_TOKEN, renderSignals, truncate, type ConsolidatePage } from './consolidate';
import type { StructuredSignals } from './discovery';
import { mapPages, renderMappedPage, type MapPagesResult } from './page-summary';

// Re-exported so existing callers (`gateway-chat.ts`, tests) that import these
// from `./extract` keep working — the types and the loose-JSON parser moved
// to `./chat-json` only so `page-summary.ts` could reuse them without a
// runtime import cycle between the two modules.
export { parseJsonLoose };
export type { ChatFn, ChatMessage };

export const MAX_REPAIR_ATTEMPTS = 2;

export interface ExtractOptions {
  chat: ChatFn;
  model: string;
  signal?: AbortSignal;
  maxRepairs?: number;
}

export interface ExtractResult {
  profile: CompanyProfile;
  attempts: number;
}

const SYSTEM_PROMPT = [
  'You extract structured profiles from the text of a website. The site may be a',
  'company, an individual (a personal site or portfolio), a single product with no',
  'distinct company or person visible, or something you cannot tell from the evidence.',
  '',
  'Rules:',
  '- Respond with a single JSON object and nothing else. No prose, no markdown fences.',
  '- Decide "subjectType" from what the pages actually show, not from a guess: "company"',
  '  when the site speaks for a business, "person" when it speaks for one individual,',
  '  "product" when it is one product with no distinct owner visible, "unknown" when the',
  '  evidence does not support any of those. Fill in the field group that matches — company',
  '  fields (products, pricing, team, caseStudies, faq, integrations, techStack, locations,',
  '  founded) or person fields (headline, bio, roles, projects, writing, skills, speaking).',
  '  A site can genuinely be both (a founder\'s personal site that is also the company',
  '  homepage); when it is, fill in both groups rather than picking one.',
  '- Use null for anything the pages do not state. An empty array is correct when a section has no entries.',
  '- Never invent a person, email, product, price or fact that is not present in the supplied pages.',
  '  If you are unsure whether something was stated, leave it out.',
  '- Every URL you output must be one that appears in the supplied pages.',
  '- "sources" must list the page URLs you actually used, and must not be empty.',
  '- "sectionSources" should attribute each populated section to the page URLs it came from.',
  '- Structured data blocks marked as trusted are the site\'s own machine-readable claims;',
  '  prefer them over prose when the two disagree.',
  '- Some pages below are shown as a "(summarized)" digest rather than their full text —',
  '  that digest is a compressed, factual view of the same page, not a lower-trust source.',
].join('\n');

function buildJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(CompanyProfileSchema, {
    name: 'company_profile',
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

/** Compact, model-readable rendering of what was wrong with the last answer. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Run extraction with a bounded repair loop. Throws {@link EnrichmentError}
 * with code `extraction_failed` when no attempt produces a valid profile.
 */
export async function extractProfile(
  extractionInput: string,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const maxRepairs = opts.maxRepairs ?? MAX_REPAIR_ATTEMPTS;
  const jsonSchema = buildJsonSchema();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Extract the company profile from the following pages.\n\n${extractionInput}`,
    },
  ];

  let lastProblem = 'unknown error';

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt += 1) {
    let raw: string;
    try {
      raw = await opts.chat({ messages, model: opts.model, jsonSchema, signal: opts.signal });
    } catch (err) {
      // A transport failure is not an extraction failure: the worker should be
      // able to retry the job rather than record a permanent verdict.
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonLoose(raw);
    } catch (err) {
      lastProblem = `response was not valid JSON (${(err as Error).message})`;
      messages.push(
        { role: 'assistant', content: raw.slice(0, 4_000) },
        {
          role: 'user',
          content:
            `That response was not valid JSON: ${(err as Error).message}\n` +
            'Reply again with the JSON object only — no prose, no code fences.',
        },
      );
      continue;
    }

    const result = CompanyProfileSchema.safeParse(parsed);
    if (result.success) {
      return { profile: result.data, attempts: attempt };
    }

    lastProblem = formatIssues(result.error);
    messages.push(
      { role: 'assistant', content: JSON.stringify(parsed).slice(0, 4_000) },
      {
        role: 'user',
        content:
          `That JSON did not match the required schema:\n${lastProblem}\n` +
          'Fix exactly these problems and reply with the corrected JSON object only. ' +
          'Do not invent values to satisfy the schema — use null, or an empty array, ' +
          'where the pages do not say.',
      },
    );
  }

  throw new EnrichmentError(
    'extraction_failed',
    `no schema-valid profile after ${maxRepairs + 1} attempts: ${lastProblem}`,
  );
}

/**
 * The reduce pass gets more room than a single-pass extraction did (80k vs the
 * old 60k) because map summaries are dense — most of what used to be spent on
 * truncated raw prose is now spent on structured facts, so the same budget
 * covers more of the site rather than more of each page.
 */
export const REDUCE_TOKEN_BUDGET = 80_000;

export interface MapReduceOptions extends ExtractOptions {
  tokenBudget?: number;
  mapThreshold?: number;
  mapConcurrency?: number;
}

export interface MapReduceResult extends ExtractResult {
  summarizedPages: number;
  degradedPages: number;
  includedUrls: string[];
  omittedUrls: string[];
}

/**
 * Assemble the reduce prompt from the trusted-signals header (identical to the
 * single-pass consolidator's) plus one rendering per page — a compact digest
 * for pages that were mapped, raw text for pages that were short enough to
 * skip mapping or that fell back to an excerpt after a failed map call. Budget
 * enforcement mirrors `consolidate()`: append until the budget is spent, then
 * name what got left out rather than silently shrinking the model's view.
 */
export function buildReduceInput(
  domain: string,
  signals: StructuredSignals,
  mapResult: MapPagesResult,
  tokenBudget: number = REDUCE_TOKEN_BUDGET,
): { text: string; includedUrls: string[]; omittedUrls: string[] } {
  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const header = renderSignals(domain, signals);
  const sections: string[] = [header];
  let used = header.length;

  const includedUrls: string[] = [];
  const omittedUrls: string[] = [];

  for (const page of mapResult.mapped) {
    const rendered = renderMappedPage(page);
    if (used + rendered.length > budgetChars) {
      omittedUrls.push(page.url);
      continue;
    }
    sections.push(rendered);
    used += rendered.length;
    includedUrls.push(page.url);
  }

  if (omittedUrls.length > 0) {
    sections.push(
      `\n[${omittedUrls.length} further page(s) were not included because the input limit was reached. Do not guess at their contents.]`,
    );
  }

  return { text: sections.join('\n\n'), includedUrls, omittedUrls };
}

/**
 * Task 2's link harvest is deterministic HTML parsing, not the model's
 * judgment — so a social or email the model never mentioned is evidence it
 * didn't look, not evidence the site lacks one. This runs strictly after the
 * profile has already cleared the Zod gate in `extractProfile`, and every
 * value it adds is re-validated through the same per-field schemas the model's
 * own output goes through, so a malformed harvested URL can never slip past
 * the "nothing unvalidated is stored" guarantee just because it skipped the
 * repair loop.
 */
export function mergeHarvestedSignals(
  profile: CompanyProfile,
  signals: StructuredSignals,
): CompanyProfile {
  const seenUrls = new Set(profile.socials.map((s) => s.url.trim().toLowerCase()));
  const socials = [...profile.socials];
  for (const harvested of signals.socials) {
    const key = harvested.url.trim().toLowerCase();
    if (seenUrls.has(key)) continue;
    const parsed = SocialLinkSchema.safeParse(harvested);
    if (!parsed.success) continue;
    seenUrls.add(key);
    socials.push(parsed.data);
  }

  // The schema has one contact email, not a list — fill it from the harvest
  // only when the model left it null; never overwrite what the model found.
  const email = profile.contact.email ?? ContactSchema.shape.email.parse(signals.emails[0] ?? null);

  return {
    ...profile,
    socials,
    contact: { ...profile.contact, email },
  };
}

/**
 * The map/reduce entry point: map each page (or pass it through raw, or
 * degrade it to an excerpt) via `page-summary.ts`, reduce the result through
 * the same repair-loop `extractProfile` already runs, then merge in the
 * deterministically harvested links. Exported so the worker can call this in
 * place of `consolidate()` + `extractProfile()` with a single-line change.
 */
export async function extractProfileFromPages(
  domain: string,
  pages: ConsolidatePage[],
  signals: StructuredSignals,
  opts: MapReduceOptions,
): Promise<MapReduceResult> {
  const mapResult = await mapPages(pages, {
    chat: opts.chat,
    model: opts.model,
    signal: opts.signal,
    threshold: opts.mapThreshold,
    concurrency: opts.mapConcurrency,
  });

  const { text, includedUrls, omittedUrls } = buildReduceInput(
    domain,
    signals,
    mapResult,
    opts.tokenBudget ?? REDUCE_TOKEN_BUDGET,
  );

  const { profile, attempts } = await extractProfile(text, opts);

  return {
    profile: mergeHarvestedSignals(profile, signals),
    attempts,
    summarizedPages: mapResult.summarizedCount,
    degradedPages: mapResult.failedCount,
    includedUrls,
    omittedUrls,
  };
}
