/**
 * Colouring for the snippet panel, without a highlighter dependency.
 *
 * The panel is a product surface — a wrapper author reads these blocks to learn
 * what to call — so the code deserves to look like code. It does not deserve a
 * megabyte of grammar bundles: shipping a full highlighter into a reference app
 * is a build-time cost and a supply-chain surface for something purely
 * cosmetic. Three tiny scanners cover the only three shapes the panel renders.
 *
 * Two properties matter more than the colours, and both are enforced here
 * rather than trusted:
 *
 * 1. HIGHLIGHTING CANNOT ALTER THE TEXT. Every token is a slice of the input,
 *    emitted in order, and `highlight` re-checks that the pieces still spell
 *    the original before handing them out. Someone pastes this into an editor;
 *    a dropped brace or a swallowed space would be a broken call.
 * 2. INPUT IT DOES NOT UNDERSTAND DEGRADES TO PLAIN TEXT. An unterminated
 *    string, a stray brace, an empty block — the scanners consume it as-is and
 *    never throw, because a snippet that fails to render teaches nothing.
 *
 * Every scanner advances by at least one character per step and never looks
 * backwards, so cost is linear in the input. No regular expression runs over
 * the source: this re-runs on every dialog open.
 */

export type SnippetLanguage = 'ts' | 'json' | 'http';

/**
 * Token roles, not lexical categories — the panel colours by what a reader is
 * looking for. A header NAME is a key like a JSON key is, and a header VALUE is
 * a value like a JSON string is, so they share roles rather than inventing two
 * more.
 */
export type TokenKind =
  | 'plain'
  | 'punctuation'
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'property'
  | 'method'
  | 'path';

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Enough of TypeScript to read a call: the words that carry the structure. */
const TS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
]);

const TS_PUNCTUATION = new Set([
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '.',
  ':',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  '&',
  '|',
  '^',
  '~',
]);

const JSON_PUNCTUATION = new Set(['{', '}', '[', ']', ',', ':']);

const QUOTES = new Set(['"', "'", '`']);

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_' || char === '$';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

/**
 * Appends one slice, merging into the previous token when the role is the same.
 * Runs are consumed whole rather than character by character, so this merges
 * rarely and the token list stays short enough to render as spans.
 */
function push(tokens: Token[], text: string, kind: TokenKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  tokens.push({ text, kind });
}

/** Consumes while the predicate holds. Always returns an index > `from` when
 *  the first character matches, which is what keeps every scanner advancing. */
function runEnd(source: string, from: number, matches: (char: string) => boolean): number {
  let index = from;
  while (index < source.length && matches(source[index] as string)) index += 1;
  return index;
}

/**
 * End index of a quoted run, one past the closing quote.
 *
 * An unterminated quote stops at the end of the line (or the input) instead of
 * swallowing the rest of the snippet: a missing quote should mis-colour one
 * line, not black out everything after it.
 */
function stringEnd(source: string, from: number): number {
  const quote = source[from];
  let index = from + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === '\n' && quote !== '`') return index;
    index += 1;
  }
  return source.length;
}

/** True when the next non-whitespace character is `:` — i.e. what just ended is
 *  a key rather than a value. Only whitespace is skipped, and that whitespace is
 *  consumed by the caller's next step, so the total work stays linear. */
function precedesColon(source: string, from: number): boolean {
  const index = runEnd(source, from, isWhitespace);
  return source[index] === ':';
}

function tokenizeTs(source: string, tokens: Token[]): void {
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;

    if (isWhitespace(char)) {
      const end = runEnd(source, index, isWhitespace);
      push(tokens, source.slice(index, end), 'plain');
      index = end;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      const end = runEnd(source, index, (c) => c !== '\n');
      push(tokens, source.slice(index, end), 'comment');
      index = end;
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      // An unclosed block comment runs to the end — the same thing an editor
      // does, and the text is preserved either way.
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      push(tokens, source.slice(index, end), 'comment');
      index = end;
      continue;
    }

    if (QUOTES.has(char)) {
      const end = stringEnd(source, index);
      // `{ agent: 'support' }` and `{ 'agent': 'support' }` read the same way,
      // so a quoted key is coloured as a key here too.
      push(tokens, source.slice(index, end), precedesColon(source, end) ? 'property' : 'string');
      index = end;
      continue;
    }

    if (isDigit(char)) {
      const end = runEnd(source, index, (c) => isDigit(c) || c === '.' || c === '_');
      push(tokens, source.slice(index, end), 'number');
      index = end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const end = runEnd(source, index, isIdentifierPart);
      const word = source.slice(index, end);
      const kind: TokenKind = TS_KEYWORDS.has(word)
        ? 'keyword'
        : precedesColon(source, end)
          ? 'property'
          : 'plain';
      push(tokens, word, kind);
      index = end;
      continue;
    }

    if (TS_PUNCTUATION.has(char)) {
      // `/` is punctuation AND the start of a comment, so a run of operators
      // stops rather than swallowing the `//` that follows `);`.
      let end = index;
      while (end < source.length && TS_PUNCTUATION.has(source[end] as string)) {
        const opensComment =
          source[end] === '/' && (source[end + 1] === '/' || source[end + 1] === '*');
        if (end > index && opensComment) break;
        end += 1;
      }
      push(tokens, source.slice(index, end), 'punctuation');
      index = end;
      continue;
    }

    // Anything the scanner has no opinion about — accented letters, symbols,
    // the typographic quotes in a summary line — stays plain rather than
    // stopping the scan.
    const end = runEnd(
      source,
      index,
      (c) =>
        !isWhitespace(c) &&
        !QUOTES.has(c) &&
        !isDigit(c) &&
        !isIdentifierStart(c) &&
        !TS_PUNCTUATION.has(c),
    );
    push(tokens, source.slice(index, end), 'plain');
    index = end;
  }
}

function tokenizeJson(source: string, tokens: Token[], from = 0): void {
  let index = from;
  while (index < source.length) {
    const char = source[index] as string;

    if (isWhitespace(char)) {
      const end = runEnd(source, index, isWhitespace);
      push(tokens, source.slice(index, end), 'plain');
      index = end;
      continue;
    }

    if (QUOTES.has(char)) {
      const end = stringEnd(source, index);
      // The distinction the panel exists to make legible: a KEY is the field
      // name upstream reads, a VALUE is what a wrapper author swaps out.
      push(tokens, source.slice(index, end), precedesColon(source, end) ? 'property' : 'string');
      index = end;
      continue;
    }

    if (isDigit(char) || (char === '-' && isDigit(source[index + 1] ?? ''))) {
      const end = runEnd(
        source,
        index + 1,
        (c) => isDigit(c) || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-',
      );
      push(tokens, source.slice(index, end), 'number');
      index = end;
      continue;
    }

    if (JSON_PUNCTUATION.has(char)) {
      const end = runEnd(source, index, (c) => JSON_PUNCTUATION.has(c));
      push(tokens, source.slice(index, end), 'punctuation');
      index = end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const end = runEnd(source, index, isIdentifierPart);
      const word = source.slice(index, end);
      const literal = word === 'true' || word === 'false' || word === 'null';
      push(tokens, word, literal ? 'keyword' : 'plain');
      index = end;
      continue;
    }

    const end = runEnd(
      source,
      index,
      (c) =>
        !isWhitespace(c) &&
        !QUOTES.has(c) &&
        !isDigit(c) &&
        !isIdentifierStart(c) &&
        !JSON_PUNCTUATION.has(c),
    );
    push(tokens, source.slice(index, end), 'plain');
    index = end;
  }
}

/**
 * The wire form: a request line, header lines, then a blank line and a JSON
 * body — exactly what `renderHttp` builds. The blank line is the split, and
 * `JSON.stringify` never emits one, so the first `\n\n` is always the boundary.
 */
function tokenizeHttp(source: string, tokens: Token[]): void {
  const separator = source.indexOf('\n\n');
  const head = separator === -1 ? source : source.slice(0, separator);

  const lines = head.split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    if (line > 0) push(tokens, '\n', 'plain');
    if (line === 0) tokenizeRequestLine(lines[line] as string, tokens);
    else tokenizeHeaderLine(lines[line] as string, tokens);
  }

  if (separator === -1) return;
  push(tokens, '\n\n', 'plain');
  tokenizeJson(source, tokens, separator + 2);
}

function tokenizeRequestLine(line: string, tokens: Token[]): void {
  const space = line.indexOf(' ');
  if (space <= 0) {
    push(tokens, line, 'plain');
    return;
  }
  const method = line.slice(0, space);
  const isMethod = method.split('').every((char) => char >= 'A' && char <= 'Z');
  push(tokens, method, isMethod ? 'method' : 'plain');
  push(tokens, ' ', 'plain');
  push(tokens, line.slice(space + 1), isMethod ? 'path' : 'plain');
}

function tokenizeHeaderLine(line: string, tokens: Token[]): void {
  const colon = line.indexOf(':');
  if (colon <= 0) {
    push(tokens, line, 'plain');
    return;
  }
  push(tokens, line.slice(0, colon), 'property');
  push(tokens, ':', 'punctuation');
  const rest = line.slice(colon + 1);
  const valueStart = runEnd(rest, 0, isWhitespace);
  push(tokens, rest.slice(0, valueStart), 'plain');
  // Coloured as a value because that is what it is — including the
  // `$KORTIX_API_KEY` placeholder, which is the line most worth reading.
  push(tokens, rest.slice(valueStart), 'string');
}

/**
 * Spans for one snippet block.
 *
 * The re-check at the end is the whole contract: whatever the scanners did, the
 * spans still spell the input character for character, or the block renders as
 * one plain token. A colouring bug must never become a copy-paste bug.
 */
export function highlight(source: string, language: SnippetLanguage): Token[] {
  if (source.length === 0) return [];

  let tokens: Token[] = [];
  try {
    if (language === 'ts') tokenizeTs(source, tokens);
    else if (language === 'json') tokenizeJson(source, tokens);
    else tokenizeHttp(source, tokens);
  } catch {
    tokens = [];
  }

  const joined = tokens.map((token) => token.text).join('');
  if (joined !== source) return [{ text: source, kind: 'plain' }];
  return tokens;
}
