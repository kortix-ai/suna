// A search request as the index SQL needs it. Pure, so the parsing rules are
// tested without a database.

export const SEARCH_LIMITS = { qMax: 200, limitDefault: 20, limitMax: 100 } as const;

/** At most this many words of a query reach the full-text match. */
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 64;

export interface ParsedQuery {
  /** The text as asked, trimmed. */
  text: string;
  /**
   * A `to_tsquery('simple', …)` input: every word of the query, all required,
   * each a prefix match from 2 characters on. Only letters and digits reach
   * it, so it never carries tsquery syntax. Empty when the query has no word.
   */
  tsquery: string;
  /** An `ILIKE … ESCAPE '\'` pattern: the whole query anywhere in a name. */
  namePattern: string;
}

/** `%`, `_` and `\` matched as themselves in a LIKE pattern with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The words of a query as the index splits text: runs of letters and digits, lower case. */
export function queryTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    const term = word.slice(0, MAX_TERM_CHARS);
    if (!terms.includes(term)) terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** Null when the query is empty after trimming, or longer than {@link SEARCH_LIMITS.qMax}. */
export function parseSearchQuery(raw: string | undefined | null): ParsedQuery | null {
  const text = (raw ?? '').trim();
  if (!text || text.length > SEARCH_LIMITS.qMax) return null;
  const tsquery = queryTerms(text)
    .map((t) => (t.length >= 2 ? `${t}:*` : t))
    .join(' & ');
  return { text, tsquery, namePattern: `%${escapeLike(text)}%` };
}

/** The page size: the default when absent, clamped to 1..limitMax; null when it is not a whole number. */
export function parseLimit(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return SEARCH_LIMITS.limitDefault;
  if (!/^\d+$/.test(raw)) return null;
  return Math.min(Math.max(Number(raw), 1), SEARCH_LIMITS.limitMax);
}

/** A page cursor: how many ranked rows the earlier pages consumed. Opaque to callers. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

/** The offset of a cursor; null when it is not one this route made. */
export function decodeCursor(raw: string | undefined | null): number | null {
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const offset = (parsed as { o?: unknown } | null)?.o;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000 ? offset : null;
  } catch {
    return null;
  }
}
