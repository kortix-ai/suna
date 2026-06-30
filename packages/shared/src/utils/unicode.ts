/**
 * Normalize filename to NFC (Normalized Form Composed) and sanitize Unicode spaces
 * to ensure consistent representation across different systems, especially macOS which
 * can use NFD (Normalized Form Decomposed) and Unicode spaces in timestamps.
 *
 * @param filename The filename to normalize
 * @returns The filename normalized to NFC form with Unicode spaces converted to regular spaces
 */
export const normalizeFilenameToNFC = (filename: string): string => {
  try {
    // First normalize to NFC (Normalized Form Composed)
    let normalized = filename.normalize('NFC');

    // Replace problematic Unicode spaces with regular ASCII spaces
    // This fixes the common macOS issue where screenshots have Unicode spaces before PM/AM
    const unicodeSpaces = [
      '\u00A0', // Non-breaking space
      '\u2000', // En quad
      '\u2001', // Em quad
      '\u2002', // En space
      '\u2003', // Em space
      '\u2004', // Three-per-em space
      '\u2005', // Four-per-em space
      '\u2006', // Six-per-em space
      '\u2007', // Figure space
      '\u2008', // Punctuation space
      '\u2009', // Thin space
      '\u200A', // Hair space
      '\u202F', // Narrow no-break space (common in macOS screenshots)
      '\u205F', // Medium mathematical space
      '\u3000', // Ideographic space
    ];

    // Replace all Unicode spaces with regular ASCII space
    for (const unicodeSpace of unicodeSpaces) {
      normalized = normalized.replaceAll(unicodeSpace, ' ');
    }

    return normalized;
  } catch (error) {
    console.warn('Failed to normalize filename to NFC:', filename, error);
    return filename;
  }
};

/**
 * Normalize file path to NFC (Normalized Form Composed) to ensure consistent
 * Unicode representation across different systems.
 *
 * @param path The file path to normalize
 * @returns The path with all components normalized to NFC form
 */
export const normalizePathToNFC = (path: string): string => {
  try {
    // Normalize to NFC (Normalized Form Composed)
    return path.normalize('NFC');
  } catch (error) {
    console.warn('Failed to normalize path to NFC:', path, error);
    return path;
  }
};

// The NUL control character (U+0000). Built via fromCharCode so this source
// file stays pure ASCII: a literal NUL byte would make the file binary.
const NUL_CHAR = String.fromCharCode(0);

/**
 * Strip NUL characters (U+0000) from a string.
 *
 * Postgres cannot store U+0000 in either a `text` or a `jsonb` column. A jsonb
 * value whose JSON text carries the U+0000 escape is rejected at parse time
 * with `22P05 unsupported Unicode escape sequence` (the NUL "cannot be
 * converted to text"). LLM request/response bodies routinely smuggle NUL bytes
 * in (binary file reads, raw terminal output, truncated tool results), so any
 * free-form string headed for Postgres must be scrubbed first. U+0000 carries
 * no meaning in our text payloads, so we drop it rather than substitute.
 */
export const stripNullBytes = (value: string): string =>
  value.includes(NUL_CHAR) ? value.split(NUL_CHAR).join('') : value;

/**
 * Recursively strip NUL characters from every string in a JSON-like value —
 * object values, object keys, and array elements alike — returning a
 * structurally identical value safe to persist into a Postgres `jsonb`/`text`
 * column.
 *
 * Non-string primitives pass through untouched. Only arrays and plain objects
 * (those with `Object.prototype` or a null prototype, i.e. the shapes
 * `JSON.parse` produces) are recursed into; anything else (Date, Map, class
 * instances) is returned as-is, since JSON payloads never contain them.
 */
export const stripNullBytesDeep = <T>(value: T): T => {
  if (typeof value === 'string') return stripNullBytes(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => stripNullBytesDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[stripNullBytes(key)] = stripNullBytesDeep(val);
      }
      return out as unknown as T;
    }
  }
  return value;
};
