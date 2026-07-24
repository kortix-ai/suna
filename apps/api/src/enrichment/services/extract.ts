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
import { CompanyProfileSchema, type CompanyProfile } from '../schemas';

export const MAX_REPAIR_ATTEMPTS = 2;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Runs one completion and returns the assistant's raw text. */
export type ChatFn = (args: {
  messages: ChatMessage[];
  model: string;
  jsonSchema: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<string>;

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
  'You extract structured company profiles from the text of a company website.',
  '',
  'Rules:',
  '- Respond with a single JSON object and nothing else. No prose, no markdown fences.',
  '- Use null for anything the pages do not state. An empty array is correct when a section has no entries.',
  '- Never invent a person, email, product, price or fact that is not present in the supplied pages.',
  '  If you are unsure whether something was stated, leave it out.',
  '- Every URL you output must be one that appears in the supplied pages.',
  '- "sources" must list the page URLs you actually used, and must not be empty.',
  '- "sectionSources" should attribute each populated section to the page URLs it came from.',
  '- Structured data blocks marked as trusted are the site\'s own machine-readable claims;',
  '  prefer them over prose when the two disagree.',
].join('\n');

function buildJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(CompanyProfileSchema, {
    name: 'company_profile',
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

/**
 * Models sometimes wrap JSON in fences or add a sentence before it despite
 * instructions. Recovering from that is cheaper than burning a repair round,
 * so peel the common wrappers before giving up.
 */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new SyntaxError('empty response');

  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new SyntaxError('unparseable response');
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
