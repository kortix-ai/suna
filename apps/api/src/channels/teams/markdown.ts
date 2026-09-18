/**
 * Markdown → Adaptive Card elements, for the agent's `teams send` body.
 *
 * Teams renders TextBlock markdown as bold, italic, bullet/numbered lists and
 * links — and nothing else. Anything richer has to become its own element:
 *
 * - fenced code → a `Monospace` TextBlock (line breaks kept, markdown escaped)
 * - inline `code` → **bold** (there is no inline monospace in a TextBlock)
 * - `#` headings → bolder, sized TextBlocks
 * - pipe tables → an Adaptive Cards 1.5 `Table`
 * - `>` quotes → subtle text; `---` → `separator` on the next block
 * - everything else → TextBlocks, one per paragraph, markdown untouched
 *
 * Deliberately regex-based and dependency-free: the input is the agent's own
 * prose, a few kilobytes at most, and the card has a 28 KB ceiling anyway.
 */

export type CardElement = Record<string, unknown>;

/** Backslash-escape the characters Teams' TextBlock markdown would otherwise interpret. */
export function escapeCardMarkdown(value: string): string {
  return value.replace(/[*_[\]`\\]/g, (ch) => (ch === '`' ? '' : `\\${ch}`));
}

/** `code` → **code** — the only inline emphasis a TextBlock can show for it. */
function inlineCode(value: string): string {
  return value.replace(/`([^`\n]+)`/g, (_m, code: string) => `**${code.trim()}**`);
}

function textBlock(text: string, extra: CardElement = {}): CardElement {
  return { type: 'TextBlock', text, wrap: true, ...extra };
}

function codeBlock(code: string): CardElement {
  return textBlock(escapeCardMarkdown(code), { fontType: 'Monospace' });
}

function heading(level: number, text: string): CardElement {
  const size = level === 1 ? 'large' : level === 2 ? 'medium' : 'default';
  return textBlock(inlineCode(text), { weight: 'bolder', size, spacing: 'medium' });
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function table(lines: string[]): CardElement {
  const rows = lines.filter((l) => !TABLE_DIVIDER.test(l)).map(splitRow);
  const width = Math.max(...rows.map((r) => r.length));
  return {
    type: 'Table',
    columns: Array.from({ length: width }, () => ({ width: 1 })),
    firstRowAsHeader: true,
    rows: rows.map((cells, rowIndex) => ({
      type: 'TableRow',
      cells: Array.from({ length: width }, (_, i) => ({
        type: 'TableCell',
        items: [
          textBlock(inlineCode(cells[i] ?? ''), rowIndex === 0 ? { weight: 'bolder' } : {}),
        ],
      })),
    })),
  };
}

/** One paragraph of ordinary markdown, or a quote, or a heading. */
function paragraph(lines: string[], separator: boolean): CardElement | null {
  const raw = lines.join('\n').trim();
  if (!raw) return null;
  const extra: CardElement = separator ? { separator: true } : {};

  const h = /^(#{1,6})\s+(.+)$/.exec(raw);
  if (h && lines.length === 1) return { ...heading(h[1].length, h[2].trim()), ...extra };

  if (lines.every((l) => /^\s*>/.test(l))) {
    const quoted = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n').trim();
    return textBlock(inlineCode(quoted), { isSubtle: true, ...extra });
  }

  if (lines.every((l) => TABLE_ROW.test(l) || TABLE_DIVIDER.test(l)) && lines.length >= 2) {
    return { ...table(lines), ...extra };
  }

  return textBlock(inlineCode(raw), extra);
}

const ENTITIES: Record<string, string> = {
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

/** `I&#39;ll` reached a card verbatim once; TextBlock shows entities literally. `&amp;` last, so `&amp;lt;` stays `&lt;`. */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&(#39|#x27|apos|quot|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&amp;/g, '&');
}

export function markdownToCardElements(markdown: string): CardElement[] {
  const out: CardElement[] = [];
  const lines = decodeHtmlEntities(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');

  let para: string[] = [];
  let code: string[] | null = null;
  let pendingSeparator = false;

  const flushPara = () => {
    const el = paragraph(para, pendingSeparator);
    if (el) {
      out.push(el);
      pendingSeparator = false;
    }
    para = [];
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push({ ...codeBlock(code.join('\n')), ...(pendingSeparator ? { separator: true } : {}) });
        pendingSeparator = false;
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      code = [];
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      pendingSeparator = true;
      continue;
    }
    // A heading is its own block even without blank lines around it.
    if (/^#{1,6}\s+\S/.test(line)) {
      flushPara();
      para = [line];
      flushPara();
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  if (code) out.push(codeBlock(code.join('\n')));
  flushPara();
  return out;
}
