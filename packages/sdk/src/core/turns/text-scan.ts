/**
 * Linear-time string scanners for the tool-output parsers in `core/turns`.
 *
 * Each function replaces one regex that CodeQL flags as polynomial ReDoS
 * (js/polynomial-redos) now that these parsers are exported library functions
 * whose input is arbitrary tool output. Each returns exactly what the regex it
 * replaces returned — `text-scan.test.ts` runs the old regex as the oracle over
 * seeded random inputs — so call sites change their expression, not their
 * behaviour. Internal: not exported from the package.
 */

const WS = /\s/;
const WORD = /\w/;

/** JavaScript `\s`: WhiteSpace and LineTerminator. */
function isWs(ch: string | undefined): boolean {
  return ch !== undefined && WS.test(ch);
}

/** What `.` refuses to match without the `s` flag. */
function isLineTerminator(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

/**
 * Case-folds the way a non-unicode `/i` regex compares characters: upper-case
 * a character only when that yields exactly one code unit. Same length as the
 * input, so indexes carry over.
 */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch.length !== 1) {
      out += ch;
      continue;
    }
    const upper = ch.toUpperCase();
    out += upper.length === 1 ? upper : ch;
  }
  return out;
}

/** `s.replace(/\/+$/, '')` */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** `s.replace(/^\/+|\/+$/g, '')` */
export function stripEdgeSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s[start] === '/') start++;
  return stripTrailingSlashes(s.slice(start));
}

/** Capture of `/open([\s\S]*?)close/` for literal `open` and `close`, or null. */
export function textBetween(s: string, open: string, close: string): string | null {
  const o = s.indexOf(open);
  if (o === -1) return null;
  const c = s.indexOf(close, o + open.length);
  return c === -1 ? null : s.slice(o + open.length, c);
}

/** Capture of `/<tag>\n?([\s\S]*?)\n?<\/tag>/`, or null. */
export function tagBodyTrimNewline(s: string, tag: string): string | null {
  let inner = textBetween(s, `<${tag}>`, `</${tag}>`);
  if (inner === null) return null;
  if (inner.startsWith('\n')) inner = inner.slice(1);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return inner;
}

/** First `<tag…>` open: index of `<` and of its `>`. */
function openTag(s: string, tag: string, from = 0): { open: number; end: number } | null {
  const open = s.indexOf(`<${tag}`, from);
  if (open === -1) return null;
  const end = s.indexOf('>', open + 1 + tag.length);
  return end === -1 ? null : { open, end };
}

/** Capture of `/<tag([^>]*)>/`, or null. */
export function tagAttributes(s: string, tag: string): string | null {
  const found = openTag(s, tag);
  return found ? s.slice(found.open + 1 + tag.length, found.end) : null;
}

/** Capture of `/<tag[^>]*>([\s\S]*?)<\/tag>/`, or null. */
export function tagBody(s: string, tag: string): string | null {
  const found = openTag(s, tag);
  if (!found) return null;
  const close = s.indexOf(`</${tag}>`, found.end + 1);
  return close === -1 ? null : s.slice(found.end + 1, close);
}

/** `s.replace(/<tag[^>]*>[\s\S]*?<\/tag>/g, '')` */
export function removeTagBlocks(s: string, tag: string): string {
  const closeTag = `</${tag}>`;
  let out = '';
  let pos = 0;
  for (;;) {
    const found = openTag(s, tag, pos);
    if (!found) break;
    const close = s.indexOf(closeTag, found.end + 1);
    // No close after this open means none after any later open either.
    if (close === -1) break;
    out += s.slice(pos, found.open);
    pos = close + closeTag.length;
  }
  return out + s.slice(pos);
}

/**
 * Every capture of `/open(.*?)close/g`. `.` never crosses a line terminator,
 * so every match lies inside one line: scan line by line.
 */
export function textItems(s: string, open: string, close: string): string[] {
  const items: string[] = [];
  for (const line of s.split(/[\n\r\u2028\u2029]/)) {
    let pos = 0;
    for (;;) {
      const o = line.indexOf(open, pos);
      if (o === -1) break;
      const c = line.indexOf(close, o + open.length);
      if (c === -1) break;
      items.push(line.slice(o + open.length, c));
      pos = c + close.length;
    }
  }
  return items;
}

/**
 * Capture of `/:\s*(\{[\s\S]*\})\s*$/`: the `{…}` tail after the first colon
 * that is followed (past whitespace) by `{`, when the string ends in `}`.
 */
export function jsonTail(s: string): string | null {
  const t = s.trimEnd();
  if (!t.endsWith('}')) return null;
  let colon = t.indexOf(':');
  while (colon !== -1) {
    let j = colon + 1;
    while (j < t.length && isWs(t[j])) j++;
    if (t[j] === '{') return t.slice(j);
    colon = t.indexOf(':', colon + 1);
  }
  return null;
}

/**
 * `/content of .* with line numbers/i.test(s)` for `first` and `second` in
 * place of the two phrases: `first`, then any run without a line terminator,
 * then `second`, case-insensitively.
 */
export function hasPhrasePair(s: string, first: string, second: string): boolean {
  const a = fold(first);
  const b = fold(second);
  for (const line of fold(s).split(/[\n\r\u2028\u2029]/)) {
    const i = line.indexOf(a);
    if (i === -1) continue;
    if (line.lastIndexOf(b) >= i + a.length) return true;
  }
  return false;
}

/**
 * Capture of `/^\s*(?:L1|L2|…)\s*:\s*(.+?)\s*$/im` for the given labels.
 *
 * `^` is a line start, and every `\s*` may cross newlines. The value is the
 * rest of the line where it starts, less trailing whitespace. When only
 * whitespace follows the colon, the regex backtracks one character into the
 * value; that case is reproduced below.
 */
export function labelledValue(s: string, labels: readonly string[]): string | null {
  const folded = fold(s);
  const wanted = labels.map(fold);
  const n = s.length;
  const skipWs = (from: number) => {
    let i = from;
    while (i < n && isWs(s[i])) i++;
    return i;
  };
  const nextLineStart = (from: number) => {
    for (let i = from; i < n; i++) if (isLineTerminator(s[i])) return i + 1;
    return -1;
  };

  let p = 0;
  while (p !== -1 && p <= n) {
    const q = skipWs(p);
    if (q >= n) return null;
    const label = wanted.find((l) => folded.startsWith(l, q));
    if (label !== undefined) {
      const k = skipWs(q + label.length);
      if (s[k] === ':') {
        const r = skipWs(k + 1);
        if (r < n) {
          let end = r;
          while (end < n && !isLineTerminator(s[end])) end++;
          while (end > r + 1 && isWs(s[end - 1])) end--;
          return s.slice(r, end);
        }
        // Only whitespace after the colon: `.+?` takes the last character
        // that is not a line terminator, if there is one.
        for (let i = n - 1; i > k; i--) if (!isLineTerminator(s[i])) return s[i];
        return null;
      }
    }
    // Every line start up to q skips to the same q; move past its line.
    p = nextLineStart(q);
  }
  return null;
}

/**
 * Captures of `/\*\*(task-[a-z0-9]+)\*\*\s+(.+?)\s+—\s+(\w+)/` as
 * `{ id, title, status }`, or null. Reproduces the regex's backtracking: the
 * title may begin inside the whitespace run after the id when the first
 * non-space character is the dash itself.
 */
export function taskRow(s: string): { id: string; title: string; status: string } | null {
  const n = s.length;

  // wsStart[i]: start of the whitespace run that ends at i - 1 (i when none).
  const wsStart = new Array<number>(n + 1);
  wsStart[0] = 0;
  for (let i = 1; i <= n; i++) wsStart[i] = isWs(s[i - 1]) ? wsStart[i - 1] : i;

  // Dashes that can separate title and status: whitespace before, then
  // whitespace, then a word character. nextDash[i]: first such dash at >= i.
  const nextDash = new Array<number>(n + 1).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    nextDash[i] = nextDash[i + 1];
    if (s[i] !== '—' || !isWs(s[i - 1])) continue;
    let j = i + 1;
    if (!isWs(s[j])) continue;
    while (j < n && isWs(s[j])) j++;
    if (isWord(s[j])) nextDash[i] = i;
  }

  // Line terminators before i, so "no terminator in [a, b)" is O(1).
  const terminators = new Array<number>(n + 1);
  terminators[0] = 0;
  for (let i = 0; i < n; i++) terminators[i + 1] = terminators[i] + (isLineTerminator(s[i]) ? 1 : 0);
  const clean = (a: number, b: number) => terminators[b] === terminators[a];

  const statusAt = (dash: number) => {
    let j = dash + 1;
    while (isWs(s[j])) j++;
    let end = j;
    while (end < n && isWord(s[end])) end++;
    return s.slice(j, end);
  };

  for (let o = s.indexOf('**task-'); o !== -1; o = s.indexOf('**task-', o + 1)) {
    let k = o + 7;
    while (k < n && /[a-z0-9]/.test(s[k])) k++;
    if (k === o + 7 || s[k] !== '*' || s[k + 1] !== '*') continue;
    const a = k + 2;
    let firstNonWs = a;
    while (firstNonWs < n && isWs(s[firstNonWs])) firstNonWs++;
    if (firstNonWs === a) continue;

    // Title starting at the first non-space character (greedy `\s+`).
    if (firstNonWs < n && firstNonWs + 2 <= n) {
      const dash = nextDash[firstNonWs + 2] ?? -1;
      if (dash !== -1) {
        const te = Math.max(firstNonWs + 1, wsStart[dash]);
        if (clean(firstNonWs, te)) {
          return { id: s.slice(o + 2, k), title: s.slice(firstNonWs, te), status: statusAt(dash) };
        }
      }
    }
    // Backtracked: a one-character title from inside the whitespace run, when
    // the dash is the first non-space character.
    if (firstNonWs < n && nextDash[firstNonWs] === firstNonWs) {
      for (let ts = firstNonWs - 2; ts >= a + 1; ts--) {
        if (!isLineTerminator(s[ts])) {
          return { id: s.slice(o + 2, k), title: s[ts], status: statusAt(firstNonWs) };
        }
      }
    }
  }
  return null;
}

/**
 * `s.replace(/^(?:\s*Error:\s*)+/i, '').replace(/(?:\bError:\s*){2,}/gi, '')`
 */
export function stripErrorPrefixes(s: string): string {
  const isError = (t: string, i: number) => t.slice(i, i + 6).toLowerCase() === 'error:';

  // Leading `(\s*Error:\s*)+`: keep going while a full repetition matches.
  let cut = 0;
  for (;;) {
    let i = cut;
    while (i < s.length && isWs(s[i])) i++;
    if (!isError(s, i)) break;
    i += 6;
    while (i < s.length && isWs(s[i])) i++;
    cut = i;
  }
  const t = s.slice(cut);

  // Runs of two or more `\bError:\s*`.
  let out = '';
  let i = 0;
  while (i < t.length) {
    if (isError(t, i) && (i === 0 || !isWord(t[i - 1]))) {
      let j = i;
      let count = 0;
      while (isError(t, j)) {
        j += 6;
        while (j < t.length && isWs(t[j])) j++;
        count++;
      }
      if (count >= 2) {
        i = j;
        continue;
      }
    }
    out += t[i];
    i++;
  }
  return out;
}
