/**
 * Markdown → Adaptive Card elements, for the agent's `teams send` body.
 *
 * Teams renders TextBlock markdown as bold, italic, bullet/numbered lists and
 * links — and nothing else. Anything richer has to become its own element:
 *
 * - fenced code → a Teams `CodeBlock` (highlighted, first 10 lines with
 *   Expand), with a `Monospace` TextBlock fallback for mobile, which has none
 * - inline `code` → **bold** (there is no inline monospace in a TextBlock)
 * - each prose line → its own TextBlock; a run of list items → one block
 * - `#` headings → bolder, sized TextBlocks
 * - pipe tables → an Adaptive Cards 1.5 `Table`
 * - `>` quotes → subtle text; `---` → `separator` on the next block
 * - bold, italic, links and lists → passed through for TextBlock to render
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

/** Fence tags → the `language` values Teams' CodeBlock highlights. */
const CODE_LANGUAGES: Record<string, string> = {
  bash: 'Bash', sh: 'Bash', shell: 'Bash', zsh: 'Bash', console: 'Bash',
  c: 'C', cpp: 'C++', 'c++': 'C++', cc: 'C++', cs: 'C#', csharp: 'C#', 'c#': 'C#',
  css: 'CSS', bat: 'DOS', cmd: 'DOS', dos: 'DOS', go: 'Go', golang: 'Go',
  graphql: 'GraphQL', gql: 'GraphQL', html: 'HTML', java: 'Java',
  javascript: 'JavaScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript',
  json: 'JSON', jsonc: 'JSON', perl: 'Perl', pl: 'Perl', php: 'PHP',
  powershell: 'PowerShell', ps1: 'PowerShell', pwsh: 'PowerShell',
  python: 'Python', py: 'Python', sql: 'SQL',
  typescript: 'TypeScript', ts: 'TypeScript', tsx: 'TypeScript',
  vb: 'Visual Basic', vbnet: 'Visual Basic', verilog: 'Verilog', vhdl: 'VHDL', xml: 'XML',
};

/** Lines of code the mobile fallback shows before pointing at the full snippet. */
const FALLBACK_CODE_LINES = 30;

/**
 * A fenced block. Teams breaks a TextBlock only at `\n\n` outside a list, so
 * one monospace TextBlock ran a whole block onto a single line. `CodeBlock`
 * keeps every line (Teams web and desktop); mobile has no `CodeBlock` and
 * renders the fallback, whose lines are kept apart by `\n\n`.
 */
function codeBlock(code: string, fence = ''): CardElement {
  const lines = code.split('\n');
  const shown = lines.slice(0, FALLBACK_CODE_LINES).map((l) => escapeCardMarkdown(l) || ' ');
  const more = lines.length - shown.length;
  if (more > 0) shown.push(`_… ${more} more lines — open this on desktop or in Kortix._`);
  return {
    type: 'CodeBlock',
    codeSnippet: code,
    language: CODE_LANGUAGES[fence.trim().toLowerCase()] ?? 'PlainText',
    fallback: textBlock(shown.join('\n\n'), { fontType: 'Monospace' }),
  };
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * A paragraph as TextBlocks, one per prose line and one per run of list
 * items. Outside a list Teams renders a single `\n` as a space, so
 * "Deployed.\nVersion 1.2" read as one line where Slack shows two. The first
 * block carries `first` (a separator, a spacing); the rest sit tight under it.
 */
function lineBlocks(lines: string[], first: CardElement, style: CardElement = {}): CardElement[] {
  const blocks: CardElement[] = [];
  let list: string[] = [];
  const push = (text: string) => {
    blocks.push(textBlock(inlineCode(text), { ...style, ...(blocks.length === 0 ? first : { spacing: 'none' }) }));
  };
  const flushList = () => {
    if (list.length) push(list.join('\n'));
    list = [];
  };
  for (const line of lines) {
    if (LIST_ITEM.test(line) || (list.length > 0 && /^\s+\S/.test(line))) {
      list.push(line);
      continue;
    }
    flushList();
    if (line.trim()) push(line.trim());
  }
  flushList();
  return blocks;
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
function paragraph(lines: string[], separator: boolean): CardElement[] {
  const raw = lines.join('\n').trim();
  if (!raw) return [];
  const extra: CardElement = separator ? { separator: true } : {};

  const h = /^(#{1,6})\s+(.+)$/.exec(raw);
  if (h && lines.length === 1) return [{ ...heading(h[1].length, h[2].trim()), ...extra }];

  if (lines.every((l) => /^\s*>/.test(l))) {
    return lineBlocks(lines.map((l) => l.replace(/^\s*>\s?/, '')), extra, { isSubtle: true });
  }

  if (lines.every((l) => TABLE_ROW.test(l) || TABLE_DIVIDER.test(l)) && lines.length >= 2) {
    return [{ ...table(lines), ...extra }];
  }

  return lineBlocks(lines, extra);
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
  let fence = '';
  let pendingSeparator = false;

  const flushPara = () => {
    const els = paragraph(para, pendingSeparator);
    if (els.length) {
      out.push(...els);
      pendingSeparator = false;
    }
    para = [];
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push({ ...codeBlock(code.join('\n'), fence), ...(pendingSeparator ? { separator: true } : {}) });
        pendingSeparator = false;
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    const opening = /^\s*```\s*([\w#+.-]*)/.exec(line);
    if (opening) {
      flushPara();
      code = [];
      fence = opening[1] ?? '';
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
  if (code) out.push(codeBlock(code.join('\n'), fence));
  flushPara();
  return out;
}

// ── Slack mrkdwn → Teams markdown ───────────────────────────────────────────
// `classifyTurnError` (channels/slack/errors.ts) is shared with Teams, and it
// writes Slack's dialect: `:warning:` for an emoji and `*text*` for bold. Teams
// renders neither. Seen on dev 2026-09-21 — a provider-auth failure reached a
// Teams card reading literally ":warning: The model provider rejected this
// request", with the sentence in ITALIC, because `*text*` is bold in mrkdwn and
// italic in every Markdown a Teams TextBlock understands. The copy was right;
// the dialect was not.
//
// Converting at this one boundary keeps Slack's output byte-for-byte unchanged.

/** The shortcodes `classifyTurnError` emits, and nothing else. */
const MRKDWN_EMOJI: Record<string, string> = {
  warning: '⚠️',
  credit_card: '💳',
  hourglass_flowing_sand: '⏳',
  scroll: '📜',
  books: '📚',
  no_entry: '⛔',
};

const SLOT = '';

/**
 * Rewrite Slack mrkdwn as the Markdown a Teams TextBlock renders.
 *
 * - `:warning:` → ⚠️. An unmapped shortcode is DROPPED, never shown: a bare
 *   `:sparkles:` in a failure card is noise at best and looks broken at worst.
 * - `*bold*` → `**bold**`, because Teams reads a single asterisk as italic.
 * - `_italic_` → `*italic*`, with word boundaries so `session_id` survives.
 *
 * Code spans and fences are stashed first, so nothing inside them is rewritten.
 */
export function mrkdwnToTeamsMarkdown(input: string): string {
  if (!input) return input;
  const slots: string[] = [];
  const stash = (m: string) => `${SLOT}${slots.push(m) - 1}${SLOT}`;

  let out = input
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash)
    // Already-Markdown bold must not become `****bold****`.
    .replace(/\*\*[^*\n]+\*\*/g, stash);

  out = out.replace(/\*([^*\n]+)\*/g, (_m, inner: string) => `**${inner}**`);
  // `_x_` only when the underscores sit on a word boundary — `agent_name` and
  // `MS_TEAMS_TENANT_ID` appear in this copy and must be left alone.
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, (_m, lead: string, inner: string) => `${lead}*${inner}*`);
  out = out.replace(/:([a-z0-9_+-]+):/gi, (_m, name: string) => MRKDWN_EMOJI[name.toLowerCase()] ?? '');
  // Dropping a leading shortcode leaves the space it sat in front of.
  out = out.replace(/^[ \t]+/gm, '');

  return out.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_m, i: string) => slots[Number(i)] ?? '');
}
