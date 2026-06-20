type HtmlTag = {
  name: string;
  closing: boolean;
};

const SKIP_CONTENT_TAGS = new Set(['head', 'script', 'style']);
const READABLE_BREAK_TAGS = new Set([
  'article',
  'br',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'section',
  'tr',
  'ul',
]);

export function stripMarkupForToolOutput(output: string): string {
  return normalizeInlineText(stripTagLikeSegments(output));
}

export function extractReadableHtml(html: string): { title?: string; text: string } {
  const title = extractTitle(html);
  const text = normalizeReadableText(decodeHtmlEntitiesOnce(extractHtmlText(html)));

  return { title, text };
}

export function decodeHtmlEntitiesOnce(s: string): string {
  let decoded = '';
  let index = 0;

  while (index < s.length) {
    if (s[index] !== '&') {
      decoded += s[index];
      index += 1;
      continue;
    }

    const end = s.indexOf(';', index + 1);
    if (end === -1 || end - index > 16) {
      decoded += s[index];
      index += 1;
      continue;
    }

    const entity = s.slice(index + 1, end);
    const replacement = decodeEntity(entity);
    if (replacement === undefined) {
      decoded += s[index];
      index += 1;
      continue;
    }

    decoded += replacement;
    index = end + 1;
  }

  return decoded;
}

function extractTitle(html: string): string | undefined {
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart === -1) return undefined;

    const tagEnd = findTagCloseIndex(html, tagStart);
    if (tagEnd === -1) return undefined;

    const tag = readTag(html.slice(tagStart + 1, tagEnd));
    if (!tag.closing && tag.name === 'title') {
      const closing = findClosingTagRange(html, tagEnd + 1, 'title');
      const rawTitle = html.slice(tagEnd + 1, closing?.start ?? html.length);
      return normalizeInlineText(decodeHtmlEntitiesOnce(stripTagLikeSegments(rawTitle)));
    }

    index = tagEnd + 1;
  }

  return undefined;
}

function extractHtmlText(html: string): string {
  let text = '';
  let index = 0;

  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    if (html[index] !== '<') {
      text += html[index];
      index += 1;
      continue;
    }

    const tagEnd = findTagCloseIndex(html, index);
    if (tagEnd === -1) break;

    const tag = readTag(html.slice(index + 1, tagEnd));
    if (!tag.closing && SKIP_CONTENT_TAGS.has(tag.name)) {
      const closing = findClosingTagRange(html, tagEnd + 1, tag.name);
      index = closing?.end ?? html.length;
      continue;
    }

    if (READABLE_BREAK_TAGS.has(tag.name)) {
      text += '\n';
    }

    index = tagEnd + 1;
  }

  return text;
}

function stripTagLikeSegments(input: string): string {
  let text = '';
  let index = 0;

  while (index < input.length) {
    if (input.startsWith('<!--', index)) {
      const commentEnd = input.indexOf('-->', index + 4);
      index = commentEnd === -1 ? input.length : commentEnd + 3;
      continue;
    }

    if (input[index] !== '<') {
      text += input[index];
      index += 1;
      continue;
    }

    const tagEnd = findTagCloseIndex(input, index);
    if (tagEnd === -1) break;
    index = tagEnd + 1;
  }

  return text;
}

function findClosingTagRange(
  html: string,
  fromIndex: number,
  tagName: string,
): { start: number; end: number } | undefined {
  let index = fromIndex;

  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart === -1) return undefined;

    const tagEnd = findTagCloseIndex(html, tagStart);
    if (tagEnd === -1) return undefined;

    const tag = readTag(html.slice(tagStart + 1, tagEnd));
    if (tag.closing && tag.name === tagName) {
      return { start: tagStart, end: tagEnd + 1 };
    }

    index = tagEnd + 1;
  }

  return undefined;
}

function findTagCloseIndex(input: string, tagStart: number): number {
  let quote: '"' | "'" | undefined;

  for (let index = tagStart + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '>') return index;
  }

  return -1;
}

function readTag(rawTag: string): HtmlTag {
  let index = 0;

  while (index < rawTag.length && isWhitespace(rawTag[index])) {
    index += 1;
  }

  const closing = rawTag[index] === '/';
  if (closing) index += 1;

  while (index < rawTag.length && isWhitespace(rawTag[index])) {
    index += 1;
  }

  const nameStart = index;
  while (index < rawTag.length && isNameChar(rawTag[index])) {
    index += 1;
  }

  return {
    name: rawTag.slice(nameStart, index).toLowerCase(),
    closing,
  };
}

function decodeEntity(entity: string): string | undefined {
  const lower = entity.toLowerCase();

  if (lower === 'nbsp') return ' ';
  if (lower === 'amp') return '&';
  if (lower === 'lt') return '<';
  if (lower === 'gt') return '>';
  if (lower === 'quot') return '"';
  if (lower === 'apos') return "'";

  if (!lower.startsWith('#')) return undefined;

  const numeric =
    lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);

  if (!Number.isFinite(numeric) || numeric < 0) return undefined;

  try {
    return String.fromCodePoint(numeric);
  } catch {
    return undefined;
  }
}

function normalizeReadableText(text: string): string {
  return text.split('\n').map(normalizeInlineText).filter(Boolean).join('\n');
}

function normalizeInlineText(text: string): string {
  let normalized = '';
  let pendingSpace = false;

  for (const char of text) {
    if (isWhitespace(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }

    if (pendingSpace) {
      normalized += ' ';
      pendingSpace = false;
    }

    normalized += char;
  }

  return normalized.trim();
}

function isWhitespace(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f' ||
    char === '\v'
  );
}

function isNameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === ':' ||
    char === '-' ||
    char === '_'
  );
}
