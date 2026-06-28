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
