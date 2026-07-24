/**
 * Shared plumbing for turning a chat completion into typed JSON.
 *
 * Both the reduce pass (extract.ts) and the map pass (page-summary.ts) ask a
 * model for JSON-shaped output and have to tolerate the same bad habits —
 * fenced code blocks, a sentence of preamble — before parsing. Living here
 * rather than in extract.ts lets page-summary.ts reuse it without the two
 * modules importing runtime values from each other.
 */
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
