/**
 * Pure markdown helpers for math and Mermaid, shared by apps/web and apps/mobile
 * so both clients pair the same `$` delimiters and route the same fences.
 *
 * - `prepareMarkdownForKatex` runs before the markdown parser: it escapes
 *   currency dollars (`$4M`) and rewrites `\(…\)` / `\[…\]` to the `$` / `$$`
 *   delimiters remark-math (web) and the mobile markdown-it math rule parse.
 *   `prepareMarkdownForMath` (mobile) does the same outside code only.
 * - `KATEX_FENCE_LANGUAGES` are fence languages rendered as display math.
 * - `isMermaidCode` decides whether a fence renders as a Mermaid diagram.
 *
 * No dependencies and no DOM: this file runs in Next.js, Bun, and Hermes.
 */

/**
 * Escape `$` signs that start currency amounts (`$4M`, `$50K`, `$1.99`) so remark-math
 * does not pair them as inline LaTeX delimiters. Real math (`$E = mc^2$`, `$\frac{a}{b}$`)
 * is unchanged because the character after `$` is not a digit.
 */
// No lookbehind: a regex literal with (?<!…) is a parse-time SyntaxError on
// Safari <16.4 that kills the WHOLE chunk (chat + public share page). The
// optional prefix capture + replacer check is the lookbehind-free equivalent.
const CURRENCY_DOLLAR = /([\\$]?)\$(?=\d)/g;

export function escapeCurrencyDollars(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(CURRENCY_DOLLAR, (match, prefix: string) => (prefix ? match : '\\$'));
}

function countRun(text: string, start: number, character: string): number {
  let end = start;
  while (text[end] === character) end += 1;
  return end - start;
}

function findInlineCodeEnd(text: string, start: number, markerLength: number): number | null {
  let searchFrom = start + markerLength;
  while (searchFrom < text.length) {
    const markerStart = text.indexOf('`', searchFrom);
    if (markerStart === -1) return null;
    const candidateLength = countRun(text, markerStart, '`');
    if (candidateLength === markerLength) return markerStart + markerLength;
    searchFrom = markerStart + candidateLength;
  }
  return null;
}

function findFencedCodeEnd(text: string, start: number): number | null {
  if (start !== 0 && text[start - 1] !== '\n') return null;

  const openingLineEnd = text.indexOf('\n', start);
  const openingLine = text.slice(start, openingLineEnd === -1 ? text.length : openingLineEnd);
  const openingMatch = /^( {0,3})(`{3,}|~{3,})/.exec(openingLine);
  if (!openingMatch) return null;

  const marker = openingMatch[2][0];
  const markerLength = openingMatch[2].length;
  let lineStart = openingLineEnd === -1 ? text.length : openingLineEnd + 1;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const indentLength = /^ {0,3}/.exec(line)?.[0].length ?? 0;
    const candidateStart = indentLength;

    if (line[candidateStart] === marker) {
      const candidateLength = countRun(line, candidateStart, marker);
      const remainder = line.slice(candidateStart + candidateLength);
      if (candidateLength >= markerLength && /^[\t ]*\r?$/.test(remainder)) {
        return lineEnd === -1 ? text.length : lineEnd + 1;
      }
    }

    lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
  }

  return text.length;
}

interface MarkdownChunk {
  content: string;
  code: boolean;
}

function splitMarkdownCode(text: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let textStart = 0;
  let index = 0;

  const pushCode = (end: number) => {
    if (index > textStart) chunks.push({ content: text.slice(textStart, index), code: false });
    chunks.push({ content: text.slice(index, end), code: true });
    index = end;
    textStart = end;
  };

  while (index < text.length) {
    const fenceEnd = findFencedCodeEnd(text, index);
    if (fenceEnd !== null) {
      pushCode(fenceEnd);
      continue;
    }

    if (text[index] === '`') {
      const markerLength = countRun(text, index, '`');
      const inlineCodeEnd = findInlineCodeEnd(text, index, markerLength);
      if (inlineCodeEnd !== null) {
        pushCode(inlineCodeEnd);
        continue;
      }
      index += markerLength;
      continue;
    }

    index += 1;
  }

  if (textStart < text.length) chunks.push({ content: text.slice(textStart), code: false });
  return chunks;
}

function isEscapedDelimiter(text: string, delimiterStart: number): boolean {
  let precedingBackslashes = 0;
  for (let index = delimiterStart - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function findClosingDelimiter(text: string, delimiter: '\\)' | '\\]', start: number): number {
  let searchFrom = start;
  while (searchFrom < text.length) {
    const delimiterStart = text.indexOf(delimiter, searchFrom);
    if (delimiterStart === -1) return -1;
    if (!isEscapedDelimiter(text, delimiterStart)) return delimiterStart;
    searchFrom = delimiterStart + delimiter.length;
  }
  return -1;
}

function normalizeLatexText(text: string): string {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const delimiter = text.slice(index, index + 2);
    const isInline = delimiter === '\\(';
    const isDisplay = delimiter === '\\[';

    if ((!isInline && !isDisplay) || isEscapedDelimiter(text, index)) {
      output += text[index];
      index += 1;
      continue;
    }

    const closingDelimiter = isInline ? '\\)' : '\\]';
    const closingStart = findClosingDelimiter(text, closingDelimiter, index + 2);
    if (closingStart === -1) {
      output += delimiter;
      index += 2;
      continue;
    }

    const math = text.slice(index + 2, closingStart);
    if (isInline) {
      output += `$${math}$`;
    } else {
      const displayMath = math.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      if (output && !output.endsWith('\n')) output += '\n';
      output += `$$\n${displayMath}\n$$`;
      const afterDelimiter = closingStart + closingDelimiter.length;
      if (afterDelimiter < text.length && text[afterDelimiter] !== '\n') output += '\n';
    }
    index = closingStart + closingDelimiter.length;
  }

  return output;
}

/**
 * Normalize standard LaTeX delimiters to the dollar delimiters supported by remark-math.
 * Preserve delimiter-like text inside inline code and fenced code blocks.
 */
export function normalizeLatexDelimiters(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return splitMarkdownCode(text)
    .map((chunk) => (chunk.code ? chunk.content : normalizeLatexText(chunk.content)))
    .join('');
}

/**
 * Normalize markdown before Streamdown: support standard LaTeX delimiters and escape currency `$`.
 */
export function prepareMarkdownForKatex(text: string): string {
  return normalizeLatexDelimiters(escapeCurrencyDollars(text));
}

/**
 * `prepareMarkdownForKatex` that leaves inline code and fenced code as written.
 * Web's version escapes currency everywhere, so `` `echo $1` `` renders as
 * `echo \$1` there; the app renders code verbatim.
 */
export function prepareMarkdownForMath(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return splitMarkdownCode(text)
    .map((chunk) => (chunk.code ? chunk.content : normalizeLatexText(escapeCurrencyDollars(chunk.content))))
    .join('');
}

/** Fenced code languages rendered as display math (rehype-katex only handles `math` by default). */
export const KATEX_FENCE_LANGUAGES: ReadonlySet<string> = new Set(['katex', 'latex', 'math', 'tex']);

/** True when a fence language renders as display math. Case-insensitive, as on web. */
export function isMathFenceLanguage(language: string): boolean {
  return KATEX_FENCE_LANGUAGES.has(language.toLowerCase());
}

/**
 * Detects if a code block contains Mermaid syntax
 */
export function isMermaidCode(language: string, code: string): boolean {
  if (!code?.trim()) return false;

  // Check if language is explicitly mermaid
  if (language === 'mermaid') return true;

  // For unknown languages, only check if content STARTS with a mermaid diagram
  // This prevents false positives from content that happens to contain mermaid keywords
  if (!language || language === 'text' || language === 'plain') {
    const trimmed = code.trim();
    const firstLine = trimmed.split('\n')[0]?.toLowerCase().trim();

    const mermaidStarters = [
      'graph',
      'flowchart',
      'sequencediagram',
      'classdiagram',
      'statediagram',
      'erdiagram',
      'journey',
      'gantt',
      'pie',
      'gitgraph',
      'mindmap',
      'timeline',
      'sankey',
      'block',
      'quadrant',
      'requirement',
      'c4context',
      'c4container',
      'c4component',
      'c4dynamic',
      // Git graph specific patterns (gitgraph starts with these commands)
      'commit',
      'branch',
      'checkout',
      'merge',
    ];

    // Only treat as Mermaid if the first line starts with a diagram declaration
    return mermaidStarters.some((starter) => firstLine.startsWith(starter.toLowerCase()));
  }

  return false;
}
