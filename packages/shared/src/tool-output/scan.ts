// Character classes and searches the tool-output readers share. Each one means
// exactly what its regex counterpart meant, so a reader built from them
// matches the regex it replaces.

/** A regex `\s`: the JavaScript WhiteSpace and LineTerminator characters. */
export function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 160) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** A line terminator: a character `.` does not match and `$` with the `m` flag stops before. */
export function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

/** The first line terminator at or after `from`, or the length of the text. */
export function lineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isLineTerminator(text.charCodeAt(i))) return i;
  }
  return text.length;
}

/** The end of the run of regex `\s` characters that starts at `from`. */
export function whitespaceEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) i++;
  return i;
}

/** A regex `\d` without the `u` flag: `0`–`9`. */
export function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** A regex `\w` without the `u` flag: `[A-Za-z0-9_]`. */
export function isWordCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/**
 * Per-position lookups over one line, filled right to left in one pass, so a
 * reader can resolve each backtracking choice of a regex in constant time.
 * Each array has `length + 2` entries, so `i + 1` stays in range at the end.
 */
export interface LineTables {
  /** The end of the whitespace run at `i`. */
  spaceEnd: Int32Array;
  /** The end of the non-whitespace run at `i`: the first whitespace at or after it. */
  solidEnd: Int32Array;
  /** The end of the `\w` run at `i`. */
  wordEnd: Int32Array;
  /** The first line terminator at or after `i`, or the length of the line. */
  breakAt: Int32Array;
}

export function lineTables(line: string): LineTables {
  const n = line.length;
  const spaceEnd = new Int32Array(n + 2);
  const solidEnd = new Int32Array(n + 2);
  const wordEnd = new Int32Array(n + 2);
  const breakAt = new Int32Array(n + 2);
  for (const table of [spaceEnd, solidEnd, wordEnd, breakAt]) {
    table[n] = n;
    table[n + 1] = n + 1;
  }
  for (let i = n - 1; i >= 0; i--) {
    const code = line.charCodeAt(i);
    const space = isWhitespace(code);
    spaceEnd[i] = space ? (spaceEnd[i + 1] as number) : i;
    solidEnd[i] = space ? i : (solidEnd[i + 1] as number);
    wordEnd[i] = isWordCharacter(code) ? (wordEnd[i + 1] as number) : i;
    breakAt[i] = isLineTerminator(code) ? i : (breakAt[i + 1] as number);
  }
  return { spaceEnd, solidEnd, wordEnd, breakAt };
}

/**
 * For a predicate over positions `0..n`: `after[e]` is the first position at or
 * after `e` where it holds, and `before[e]` the last at or before `e`; -1 when
 * none. Each is filled in one pass.
 */
export function positionIndex(
  n: number,
  holds: (e: number) => boolean,
): { after: Int32Array; before: Int32Array } {
  const after = new Int32Array(n + 2);
  const before = new Int32Array(n + 1);
  after[n + 1] = -1;
  for (let e = n; e >= 0; e--) after[e] = holds(e) ? e : (after[e + 1] as number);
  for (let e = 0; e <= n; e++) before[e] = holds(e) ? e : e > 0 ? (before[e - 1] as number) : -1;
  return { after, before };
}

/** `needle` at `at`, ignoring ASCII case the way a regex `i` flag without `u` does. */
export function startsWithIgnoreCase(text: string, needle: string, at: number): boolean {
  if (at < 0 || at + needle.length > text.length) return false;
  for (let i = 0; i < needle.length; i++) {
    let a = text.charCodeAt(at + i);
    let b = needle.charCodeAt(i);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}
