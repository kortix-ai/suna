/**
 * A memory page body, parsed for the reader. The body is markdown that people
 * and the `remember` tool write: `## ` headings make sections, `- ` lines are
 * facts, and `⟦n⟧` (U+27E6 n U+27E7) cites the page's source number n.
 *
 * ponytail: the markdown subset memory pages use (headings, lists, paragraphs,
 * fenced code, `code`, **bold**, http(s) links). Tables and images render as
 * text; move to UnifiedMarkdown with a source-chip hook if pages need them.
 */

export type MemoryInline =
  | { kind: 'text'; text: string }
  | { kind: 'source'; number: number }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

export type MemoryBlock =
  | { kind: 'heading'; inlines: MemoryInline[] }
  | { kind: 'paragraph'; inlines: MemoryInline[] }
  | { kind: 'list'; ordered: boolean; items: MemoryInline[][] }
  | { kind: 'code'; text: string };

// Earliest match wins, so a code span that opens before a token keeps the token as text.
const INLINE = /`([^`\n]+)`|⟦(\d+)⟧|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * One line of text as inline parts. A token whose number is not in `sources`
 * renders nothing (the API keeps a token only while its source row exists).
 */
export function memoryInlines(text: string, sources: ReadonlySet<number>): MemoryInline[] {
  const out: MemoryInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += value;
    else out.push({ kind: 'text', text: value });
  };
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    pushText(text.slice(at, match.index));
    at = match.index + match[0].length;
    const [, code, number, strong, linkText, href] = match;
    if (code !== undefined) out.push({ kind: 'code', text: code });
    else if (number !== undefined) {
      const n = Number(number);
      if (sources.has(n)) out.push({ kind: 'source', number: n });
    } else if (strong !== undefined) out.push({ kind: 'strong', text: strong });
    else if (linkText !== undefined && href !== undefined) out.push({ kind: 'link', text: linkText, href });
  }
  pushText(text.slice(at));
  return out;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** The body as blocks: headings, paragraphs (soft breaks joined), lists and fenced code. */
export function memoryBlocks(body: string, sources: ReadonlySet<number>): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: memoryInlines(paragraph.join(' '), sources) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) code.push(lines[i]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', inlines: memoryInlines(heading[1]!.trim(), sources) });
    } else if (item) {
      flush();
      const ordered = !BULLET.test(line);
      const last = blocks[blocks.length - 1];
      const inlines = memoryInlines(item[1]!.trim(), sources);
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(inlines);
      else blocks.push({ kind: 'list', ordered, items: [inlines] });
    } else if (line.trim()) {
      paragraph.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  return blocks;
}

/** A body line as plain text: no list marker, no source tokens. */
function plainLine(line: string): string {
  return line
    .replace(BULLET, '$1')
    .replace(NUMBERED, '$1')
    .replace(/⟦\d+⟧/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first line `after` has that `before` lacks, as plain text: the fact a
 * change added ("Writer updated this page: added “…”"). Null when the change
 * added no text line (an edit that only removed or reordered). A closing
 * period is dropped: the line is quoted inside a sentence.
 */
export function addedLine(before: string, after: string): string | null {
  const seen = new Map<string, number>();
  for (const line of before.split('\n')) {
    const key = plainLine(line);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const line of after.split('\n')) {
    if (!line.trim() || HEADING.test(line)) continue;
    const key = plainLine(line);
    const count = seen.get(key) ?? 0;
    if (count > 0) seen.set(key, count - 1);
    else if (key) return key.replace(/[.。]$/, '');
  }
  return null;
}
