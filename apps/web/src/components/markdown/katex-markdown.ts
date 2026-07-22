import type { PluggableList } from 'unified';
import { defaultSchema } from 'rehype-sanitize';
import { defaultRehypePlugins, defaultRemarkPlugins } from 'streamdown';

// ---------------------------------------------------------------------------
// KaTeX / LaTeX markdown support for Streamdown
// ---------------------------------------------------------------------------
// Streamdown ships remark-math + rehype-katex but:
//  1. Standard `\(…\)` and `\[…\]` delimiters need normalization to remark-math delimiters.
//  2. singleDollarTextMath is enabled for `$E = mc^2$` inline math; currency like `$4M` /
//     `$50K` is escaped to `\$4M` / `\$50K` in prepareMarkdownForKatex() before parsing.
//  3. Default rehype order (raw → katex → sanitize) lets sanitize strip KaTeX SVG/MathML.
//  4. rehype-sanitize's GitHub schema strips KaTeX output if order regresses.
// ---------------------------------------------------------------------------

/** MathML tags KaTeX may emit (keep in sync with KaTeX output, not hand-picked subset). */
const KATEX_MATHML_TAG_NAMES = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'mstyle',
  'msup', 'msub', 'msubsup', 'mmultiscripts', 'mprescripts', 'mfrac', 'mover', 'munder', 'munderover',
  'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'menclose', 'merror', 'mpadded', 'mphantom',
  'mfenced', 'mglyph', 'maction', 'maligngroup', 'malignmark',
  // SVG elements for sqrt signs, fraction bars, stretchy delimiters, etc.
  'svg', 'path', 'line', 'g', 'rect',
] as const;

const katexSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), ...KATEX_MATHML_TAG_NAMES],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className', 'style', 'aria-hidden'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'fill', 'stroke'],
    path: ['d', 'fill', 'stroke', 'strokeWidth', 'stroke-width'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'stroke-width'],
    g: ['fill', 'stroke'],
    rect: ['x', 'y', 'width', 'height', 'fill', 'stroke'],
  },
};

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
 * Remark plugins for UnifiedMarkdown.
 * Inline `$…$` math is on; currency amounts are escaped upstream via prepareMarkdownForKatex().
 */
export const katexRemarkPlugins: PluggableList = Object.entries(defaultRemarkPlugins).map(
  ([key, plugin]) => {
    if (key === 'math' && Array.isArray(plugin)) {
      const [mathPlugin, mathOpts] = plugin;
      return [mathPlugin, { ...((mathOpts as Record<string, unknown>) || {}), singleDollarTextMath: true }];
    }
    return plugin;
  },
) as PluggableList;

/**
 * Build rehype plugins with sanitize BEFORE katex so KaTeX output is not stripped.
 * Streamdown default order is raw → katex → sanitize → harden (broken for fractions/sqrt).
 */
export function buildKatexRehypePlugins(includeRaw: boolean): PluggableList {
  const byKey: Record<string, PluggableList[number]> = {};
  for (const [key, plugin] of Object.entries(defaultRehypePlugins)) {
    if (key === 'sanitize' && Array.isArray(plugin)) {
      byKey[key] = [plugin[0], katexSanitizeSchema];
    } else {
      byKey[key] = plugin;
    }
  }
  const ordered: PluggableList[number][] = [];
  for (const key of ['raw', 'sanitize', 'katex', 'harden'] as const) {
    if (key === 'raw' && !includeRaw) {
      delete byKey[key];
      continue;
    }
    if (byKey[key]) {
      ordered.push(byKey[key]);
      delete byKey[key];
    }
  }
  for (const plugin of Object.values(byKey)) ordered.push(plugin);
  return ordered as PluggableList;
}

export const katexRehypePlugins = buildKatexRehypePlugins(true);
export const katexRehypePluginsNoRaw = buildKatexRehypePlugins(false);

/** Fenced code languages rendered as display math (rehype-katex only handles `math` by default). */
export const KATEX_FENCE_LANGUAGES = new Set(['katex', 'latex', 'math', 'tex']);

export const KATEX_RENDER_OPTIONS = {
  throwOnError: false,
  errorColor: 'var(--color-muted-foreground)',
  strict: 'ignore' as const,
};

export function normalizeClassName(className?: string | string[]): string {
  if (!className) return '';
  return Array.isArray(className) ? className.join(' ') : className;
}

/** True when a hast/react node belongs to KaTeX output — must not get prose Tailwind overrides. */
export function isKatexClassName(className?: string | string[]): boolean {
  const cls = normalizeClassName(className);
  if (!cls) return false;
  return /\b(katex|katex-display|katex-html|katex-mathml|katex-error|math-inline|math-display)\b/.test(cls);
}
