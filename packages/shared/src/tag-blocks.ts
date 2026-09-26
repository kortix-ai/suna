/**
 * Linear-time scanners for the XML-like tags that the runtime, the composer,
 * and the channels write into message text: `<kortix_system …>`,
 * `<reply_context>`, `<file …>`, `<project_ref …/>`, notification blocks such
 * as `<task_failed>`, and the `Referenced … (…):` header lines.
 *
 * WHY NOT REGEXES. Every reader of these tags used a lazy regex such as
 * `/<reply_context>([\s\S]*?)<\/reply_context>/`. When an opener never closes,
 * the regex scans to the end of the text for it, then again for the next
 * opener: `'<reply_context>'.repeat(16_000)` (240k characters) took ~1 s, and
 * each doubling of the text quadrupled the time. Two quantifiers that can match
 * the same characters are worse: `<file\s+([^>]*?)>` was quadratic on a single
 * opener, and `<kortix_system[^>]*?\btype="…"[^>]*?\bsource="…"` was cubic
 * (53 s at 60k characters). The text is user-controlled — a pasted message, a
 * channel message, a trigger payload — and every viewer of a session parses
 * every message in it, so one message froze the tab or the phone of each person
 * who opened the session. A tighter regex does not fix this class: any pattern
 * that re-scans to the end of the text for each opener it tries stays
 * quadratic when nothing closes.
 *
 * Each scanner here returns exactly what its regex matched: the same blocks, at
 * the same indices, non-overlapping, in order. `tag-blocks.test.ts` pins that
 * against the old regexes on thousands of random strings. Each scanner reads a
 * character a bounded number of times: every search starts where the previous
 * one stopped, and a scanner stops as soon as a delimiter it needs is absent
 * from the rest of the text — then no later opener can close either.
 */

/** A region of text: `text.slice(index, end)`. */
export interface TextSpan {
  /** Index of the first character. */
  index: number;
  /** Index just past the last character. */
  end: number;
}

/** A `<name …>…</name>` element. */
export interface TagBlock extends TextSpan {
  /**
   * The text between the name and the opening tag's `>`: empty for
   * `attributes: 'none'`, and without its leading whitespace for `'spaced'`.
   */
  attrs: string;
  /** The text between the opening tag's `>` and the closing tag. */
  body: string;
}

export interface TagBlockOptions {
  /**
   * What the opening tag may hold after its name:
   * - `'none'` (default): nothing. The opening tag is exactly `<name>`.
   * - `'any'`: any text without `>`, as `<name[^>]*>` matched. No separator is
   *   required, so `<namex>` opens a block too.
   * - `'spaced'`: whitespace, then any text without `>`, as `<name\s+[^>]*>`.
   */
  attributes?: 'none' | 'any' | 'spaced';
  /** Match the name in both tags regardless of ASCII case, as the `i` flag did. */
  ignoreCase?: boolean;
  /** Stop after this many blocks. `limit: 1` is what a non-global regex matched. */
  limit?: number;
}

/** A `<name …/>` element. */
export interface SelfClosingTag extends TextSpan {
  /** The text between the name and `/>`. */
  attrs: string;
}

/** A `<tag>…</tag>` element, whatever its tag. */
export interface XmlBlock extends TextSpan {
  /** The tag name as the opening tag spells it. */
  tag: string;
  /** The text between the tags. */
  body: string;
}

const GT = 62; // >
const COLON = 58; // :
const NEWLINE = 10; // \n
/** A regex `\s`, so whitespace means exactly what it meant to the old patterns. */
const WHITESPACE = /\s/;
/** A regex `\w` without the `u` flag: `[A-Za-z0-9_]`. */
const WORD = /\w/;

/** `A`–`Z` to `a`–`z` and nothing else: the case folding of a regex `i` flag without `u`. */
function fold(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/**
 * `text.indexOf(needle, from)`, ignoring ASCII case the way a regex `i` flag
 * without `u` does. No other character folds: the Kelvin sign is not a `k`.
 * `String.prototype.toLowerCase` cannot stand in for this, because it folds
 * non-ASCII letters and can change the length of the text.
 */
export function indexOfIgnoreCase(text: string, needle: string, from = 0): number {
  const length = needle.length;
  let i = Math.max(from, 0);
  if (length === 0) return Math.min(i, text.length);
  const last = text.length - length;
  const first = fold(needle.charCodeAt(0));
  const firstIsLetter = first >= 97 && first <= 122;
  for (; i <= last; i++) {
    if (firstIsLetter) {
      if (fold(text.charCodeAt(i)) !== first) continue;
    } else {
      // A first character with no case: let the native search jump to it.
      i = text.indexOf(needle[0]!, i);
      if (i === -1 || i > last) return -1;
    }
    let j = 1;
    while (j < length && fold(text.charCodeAt(i + j)) === fold(needle.charCodeAt(j))) j++;
    if (j === length) return i;
  }
  return -1;
}

/**
 * Every `<name …>…</name>` block, as the regex `/<name…>([\s\S]*?)<\/name>/g`
 * matched them: each opening tag pairs with the first closing tag after it.
 */
export function tagBlocks(text: string, name: string, options: TagBlockOptions = {}): TagBlock[] {
  const blocks: TagBlock[] = [];
  if (typeof text !== 'string') return blocks;
  const { attributes = 'none', ignoreCase = false, limit = Number.POSITIVE_INFINITY } = options;
  const open = `<${name}`;
  const close = `</${name}>`;
  const find = ignoreCase
    ? (needle: string, from: number) => indexOfIgnoreCase(text, needle, from)
    : (needle: string, from: number) => text.indexOf(needle, from);
  let from = 0;
  while (blocks.length < limit) {
    const index = find(open, from);
    if (index === -1) break;
    const after = index + open.length;
    let gt: number;
    if (attributes === 'none') {
      if (text.charCodeAt(after) !== GT) {
        from = after;
        continue;
      }
      gt = after;
    } else {
      // `spaced` needs whitespace right after the name: `<filex …>` is not a `<file>`.
      if (attributes === 'spaced' && !(after < text.length && WHITESPACE.test(text[after]!))) {
        from = after;
        continue;
      }
      gt = text.indexOf('>', after);
      // No `>` after this opener means none after any later opener either.
      if (gt === -1) break;
    }
    const closeAt = find(close, gt + 1);
    // Likewise: no closing tag after this opener, none after a later one.
    if (closeAt === -1) break;
    const end = closeAt + close.length;
    const raw = attributes === 'none' ? '' : text.slice(after, gt);
    blocks.push({
      index,
      end,
      attrs: attributes === 'spaced' ? raw.trimStart() : raw,
      body: text.slice(gt + 1, closeAt),
    });
    from = end;
  }
  return blocks;
}

/**
 * Every `<name …/>` tag, as `/<name\b([\s\S]*?)\/>/g` matched them: the name
 * must end there (`<project_refs` is not a `<project_ref`), and the tag ends at
 * the first `/>` after it.
 */
export function selfClosingTags(text: string, name: string): SelfClosingTag[] {
  const tags: SelfClosingTag[] = [];
  if (typeof text !== 'string') return tags;
  const open = `<${name}`;
  const nameEndsInWord = WORD.test(name[name.length - 1] ?? '');
  let from = 0;
  for (;;) {
    const index = text.indexOf(open, from);
    if (index === -1) return tags;
    const after = index + open.length;
    // `\b`: a word boundary sits between the name and what follows it.
    const nextIsWord = after < text.length && WORD.test(text[after]!);
    if (nextIsWord === nameEndsInWord) {
      from = after;
      continue;
    }
    const close = text.indexOf('/>', after);
    if (close === -1) return tags;
    tags.push({ index, end: close + 2, attrs: text.slice(after, close) });
    from = close + 2;
  }
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 95 || code === 45; // 0-9 _ -
}

/** The end of a tag name `[A-Za-z][A-Za-z0-9_-]*` that starts at `i`, or `i` when none starts there. */
function nameEnd(text: string, i: number): number {
  if (!isLetter(text.charCodeAt(i))) return i;
  let j = i + 1;
  while (j < text.length && isNameChar(text.charCodeAt(j))) j++;
  return j;
}

/**
 * Every `<tag>…</tag>` block whatever the tag, as
 * `/<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi` matched them. The closing tag
 * repeats the opening name in any ASCII case.
 */
export function xmlBlocks(text: string): XmlBlock[] {
  const blocks: XmlBlock[] = [];
  if (typeof text !== 'string') return blocks;
  // Index every closing tag once, by name. Each name's list is read front to
  // back as the openers move forward, so no closing tag is looked at twice.
  const closers = new Map<string, number[]>();
  for (let i = text.indexOf('</'); i !== -1; i = text.indexOf('</', i + 2)) {
    const end = nameEnd(text, i + 2);
    if (end === i + 2 || text.charCodeAt(end) !== GT) continue;
    const key = text.slice(i + 2, end).toLowerCase();
    const list = closers.get(key);
    if (list) list.push(i);
    else closers.set(key, [i]);
  }
  const cursor = new Map<string, number>();
  let from = 0;
  for (;;) {
    const index = text.indexOf('<', from);
    if (index === -1) return blocks;
    const end = nameEnd(text, index + 1);
    if (end === index + 1 || text.charCodeAt(end) !== GT) {
      from = index + 1;
      continue;
    }
    const tag = text.slice(index + 1, end);
    const key = tag.toLowerCase();
    const list = closers.get(key);
    const bodyStart = end + 1;
    let k = cursor.get(key) ?? 0;
    if (list) while (k < list.length && list[k]! < bodyStart) k++;
    cursor.set(key, k);
    if (!list || k === list.length) {
      from = index + 1;
      continue;
    }
    const closeAt = list[k]!;
    const blockEnd = closeAt + tag.length + 3;
    blocks.push({ index, end: blockEnd, tag, body: text.slice(bodyStart, closeAt) });
    from = blockEnd;
  }
}

/**
 * Every `Referenced <noun> (…):` header line, with the newlines before it and
 * one newline after it, as `/\n*Referenced <noun> \([^)]*\):\n?/g` matched
 * them. With `description`, the parenthesised text must be exactly that, as in
 * `/\n*Referenced sessions \(use the session_context tool …\):\n?/g`.
 *
 * The regex's leading `\n*` retried every newline of a blank run: 60k newlines
 * took 1.3 s with no header in sight.
 */
export function referenceHeaders(text: string, noun: string, description?: string): TextSpan[] {
  const spans: TextSpan[] = [];
  if (typeof text !== 'string') return spans;
  const head = `Referenced ${noun} (`;
  const fixedTail = description === undefined ? null : `${description}):`;
  let from = 0;
  // The first `)` at or after the last position searched from; -2 until searched.
  let paren = -2;
  for (;;) {
    const at = text.indexOf(head, from);
    if (at === -1) return spans;
    const inside = at + head.length;
    let end: number;
    if (fixedTail !== null) {
      if (!text.startsWith(fixedTail, inside)) {
        from = at + 1;
        continue;
      }
      end = inside + fixedTail.length;
    } else {
      // `[^)]*\):` — the first `)` after the `(` must be followed by `:`.
      if (paren < inside) paren = text.indexOf(')', inside);
      if (paren === -1) return spans;
      if (text.charCodeAt(paren + 1) !== COLON) {
        from = at + 1;
        continue;
      }
      end = paren + 2;
    }
    if (text.charCodeAt(end) === NEWLINE) end += 1;
    // `\n*`: the newlines right before the header, but not inside the previous match.
    let index = at;
    while (index > from && text.charCodeAt(index - 1) === NEWLINE) index -= 1;
    spans.push({ index, end });
    from = end;
  }
}

/**
 * The text with each span replaced by `replace(span)`, as `text.replace(regex,
 * fn)` did. `spans` must be in order and must not overlap, as every scanner
 * here returns them.
 */
export function replaceSpans<T extends TextSpan>(
  text: string,
  spans: readonly T[],
  replace: (span: T) => string,
): string {
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.index) + replace(span);
    last = span.end;
  }
  return out + text.slice(last);
}

/** The text without the spans, as `text.replace(regex, '')` did. */
export function removeSpans(text: string, spans: readonly TextSpan[]): string {
  return replaceSpans(text, spans, () => '');
}
