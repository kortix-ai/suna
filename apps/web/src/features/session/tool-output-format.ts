/**
 * Shared formatting for raw tool input/output blobs so oversized, truncated, or
 * JSON-heavy payloads render as tidy, capped content instead of a garbled wall
 * of text. Used by the default tool-output fallback and the web_search / scrape
 * renderers.
 */

/** Does this payload look like a JSON object/array (incl. truncated)? */
export function looksLikeJsonPayload(text: string | undefined): boolean {
  const s = (text ?? '').trimStart();
  return s.startsWith('{') || s.startsWith('[');
}

/**
 * Pretty-print a raw output blob when it parses as JSON (including the
 * double-encoded string case), then cap it to `maxChars`. Non-JSON text is
 * left as-is and capped. Returns the trimmed text plus how many characters
 * were dropped so the UI can show a "+N more" hint.
 */
export function formatRawOutput(
  output: string | undefined,
  maxChars = 2000,
): { text: string; truncatedChars: number } {
  let s = (output ?? '').trim();

  try {
    let value: unknown = JSON.parse(s);
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep the inner string */
      }
    }
    if (value && typeof value === 'object') {
      s = JSON.stringify(value, null, 2);
    }
  } catch {
    /* not JSON — leave as raw text */
  }

  if (s.length > maxChars) {
    return { text: s.slice(0, maxChars).trimEnd(), truncatedChars: s.length - maxChars };
  }
  return { text: s, truncatedChars: 0 };
}

/**
 * Turn a scraped/searched page's raw content into a clean one-line preview:
 * drop markdown image/link syntax and heading/emphasis marks, collapse
 * whitespace and immediately-repeated words (a common artifact of hover-reveal
 * site text), then cap to `maxChars`.
 */
export function cleanResultSnippet(content: string | undefined, maxChars = 200): string {
  let s = content ?? '';
  s = s.replace(/\\n/g, ' '); // literal escaped newlines
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // markdown images
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // markdown links → text
  s = s.replace(/[#*_`>]+/g, ' '); // heading / emphasis / code / quote marks
  s = s.replace(/\s+/g, ' ').trim(); // collapse whitespace
  s = s.replace(/\b(\w{2,})(?:\s+\1\b)+/gi, '$1'); // collapse repeated words
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s;
}

export interface EmbeddedFailure {
  /** Fully-unwrapped, human-readable error message. */
  message: string;
  /** HTTP status code recovered from a nested error payload, if any. */
  status?: number;
}

/**
 * Detect the "well-known" embedded-failure shape some tools return even when
 * the outer part state is `completed`: a JSON object with `success: false`
 * and a string `error` field — e.g. a `web_search` call that hit a 402 from
 * the search provider still reports `state.status: "completed"` because the
 * *tool call* completed, only the underlying request failed.
 *
 * The `error` string is frequently itself a wrapper around a nested JSON
 * error object (proxy error → upstream error), e.g.
 * `"Error: 402 Error: {\"message\":\"Insufficient credits\",\"status\":402}"`.
 * This unwraps up to a few levels of that nesting so callers can show the
 * innermost human message ("Insufficient credits") instead of the raw blob.
 *
 * Deliberately conservative: only matches this exact `{success:false,
 * error:string}` shape so it never misfires on legitimate tool payloads that
 * happen to contain the words "success" or "error".
 */
export function parseEmbeddedFailure(output: string | undefined): EmbeddedFailure | null {
  const trimmed = (output ?? '').trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.success !== false || typeof obj.error !== 'string' || !obj.error.trim()) return null;

  let message = obj.error.trim();
  let status: number | undefined;

  // Unwrap `... : {json}` tails: proxy errors often wrap an upstream error
  // object. Walk a few levels deep so a doubly-wrapped message still resolves.
  for (let i = 0; i < 3; i++) {
    const nestedMatch = message.match(/:\s*(\{[\s\S]*\})\s*$/);
    if (!nestedMatch) break;
    let nested: Record<string, unknown>;
    try {
      nested = JSON.parse(nestedMatch[1]);
    } catch {
      break;
    }
    if (typeof nested.status === 'number') status = nested.status;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      message = nested.message.trim();
    } else if (typeof nested.error === 'string' && nested.error.trim()) {
      message = nested.error.trim();
    } else {
      break;
    }
  }

  return { message, status };
}

export interface RecoveredResult {
  title: string;
  url: string;
  snippet?: string;
}

function decodeJsonStringLiteral(escaped: string): string {
  try {
    return JSON.parse(`"${escaped}"`) as string;
  } catch {
    return escaped;
  }
}

/**
 * Best-effort extraction of {title, url, snippet} records from a raw — and
 * possibly truncated or oversized — web-search/scrape JSON blob. Used when
 * strict JSON.parse fails (the model's tool output is frequently truncated mid
 * stream) so the UI can still show clean result cards instead of dumping the
 * raw JSON. Scans field by field, so a cut-off tail just drops its last record.
 */
export function recoverLinkResults(raw: string | undefined, max = 30): RecoveredResult[] {
  if (!raw) return [];
  const out: RecoveredResult[] = [];
  const seen = new Set<string>();
  const push = (title: string, url: string, snippet?: string) => {
    if (!/^https?:\/\//i.test(url) || seen.has(url) || out.length >= max) return;
    seen.add(url);
    out.push({ title: title.trim() || url, url, snippet: snippet?.trim() || undefined });
  };

  // title → url (→ snippet/content/text): the common search-result ordering.
  const titleFirst =
    /"title"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"url"\s*:\s*"((?:\\.|[^"\\])*)"(?:\s*,\s*"(?:snippet|content|text)"\s*:\s*"((?:\\.|[^"\\])*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = titleFirst.exec(raw)) !== null) {
    push(
      decodeJsonStringLiteral(m[1]),
      decodeJsonStringLiteral(m[2]),
      m[3] ? decodeJsonStringLiteral(m[3]) : undefined,
    );
    if (out.length >= max) return out;
  }

  // url → … → title (scrape ordering), only if the first pass found nothing.
  if (out.length === 0) {
    const urlFirst = /"url"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]{0,400}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    while ((m = urlFirst.exec(raw)) !== null) {
      push(decodeJsonStringLiteral(m[2]), decodeJsonStringLiteral(m[1]));
      if (out.length >= max) return out;
    }
  }

  return out;
}
