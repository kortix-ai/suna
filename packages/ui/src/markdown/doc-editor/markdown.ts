import { getSchema } from '@tiptap/core';
import { DOMParser as ProseMirrorParser, DOMSerializer, type Schema } from '@tiptap/pm/model';
import { Lexer, Marked, type Links, type Token } from 'marked';
import TurndownService from 'turndown';
import { strikethrough, tables } from 'turndown-plugin-gfm';

import { docExtensions } from './doc-extensions';
import {
  LAYOUT_WHITESPACE,
  MAX_DOC_BYTES,
  MD_ATTRIBUTE,
  RAW_ATTRIBUTE,
  blockKind,
  hashText,
  readMd,
  writeMd,
  type MdBlock,
} from './doc-fidelity';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Raw HTML in the Markdown shows as the text it is (`<package>` in a
 * sentence), so the editor keeps it and saves it back. The editor has no
 * node for an unknown tag and would drop it. A `<video>` and a link card
 * (`<div class="kx-embed">`, doc-embed.tsx) are the tags a doc holds as HTML,
 * and `<u>` in a sentence is the editor's underline (Markdown has none).
 */
const DOC_HTML = /^(<\/?video\b|<div class="kx-embed">)/i;
const UNDERLINE = /^<\/?u>$/i;
const parser = new Marked({
  renderer: {
    html: ({ text, block }) =>
      DOC_HTML.test(text.trim()) || (!block && UNDERLINE.test(text.trim())) ? text : escapeHtml(text),
  },
});

/** marked's HTML in the editor's shape. */
function editorHtml(html: string): string {
  return (
    html
      // marked's task items → the editor's (`li[data-type=taskItem]`).
      // A loose list (blank lines between items) puts the box inside a <p>: keep the <p> as the item's text.
      .replace(/<li>(<p>)?<input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, p, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">${p ?? ''}`)
      .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1')
      // marked keeps a fence's last newline; the editor would show it as an empty line.
      .replace(/\n<\/code><\/pre>/g, '</code></pre>')
  );
}

/** The whole file through marked, as the editor has always opened it (`tokens`: the file already lexed). */
function convertedHtml(markdown: string, tokens: Token[] = parser.lexer(markdown)): string {
  const doc = new DOMParser().parseFromString(editorHtml(parser.parser(tokens) as string), 'text/html');
  markSoftBreaks(doc);
  return doc.body.innerHTML;
}

/**
 * The document editor holds Markdown files (a doc artifact, an agent's
 * instructions). The editor works in HTML, so a doc goes Markdown → HTML on
 * load and HTML → Markdown on save. GFM tables, strikethrough and task lists
 * survive the round trip, and so do the file's own line breaks: a source
 * line break inside a paragraph (a soft break) becomes
 * `<span data-soft-break>`, which reads as a space and saves as a newline.
 * A file wrapped at 72 columns stays wrapped, so a one-word edit is a
 * one-line diff.
 *
 * A file the editor would write differently (`* item`, a setext heading, an
 * aligned table, three blank lines, no final newline) keeps its own spelling
 * (`sourcePlan`): an unedited block saves byte for byte, and a block the
 * editor cannot show at all (front matter, a link definition, an HTML block)
 * opens as a raw block of Markdown text.
 */
export function markdownToHtml(markdown: string): string {
  return plan(markdown).html;
}

export type DocRoundTrip = {
  /** Saving the file unedited from the editor gives the same bytes. */
  ok: boolean;
  /** Why not: over 1 MiB, mixed line endings, or a shape the editor cannot keep. */
  reason?: 'too-large' | 'line-endings' | 'unstable';
};

/**
 * Whether a person can open `markdown` in the editor and save it without a
 * byte changing: the condition for co-editing a doc, where every client
 * flushes the file from the editor. One whole-document pass when the editor
 * already writes the file as it is; the plan is cached for the
 * `markdownToHtml` call that opens it.
 */
export function docRoundTrips(markdown: string): DocRoundTrip {
  const { ok, reason } = plan(markdown);
  return ok ? { ok } : { ok, reason };
}

type Plan = { html: string; ok: boolean; reason?: DocRoundTrip['reason'] };

// The last few files planned: the guard and the editor's load ask for the same one.
const plans = new Map<string, Plan>();

function plan(markdown: string): Plan {
  const hit = plans.get(markdown);
  if (hit) return hit;
  const made = makePlan(markdown);
  plans.set(markdown, made);
  if (plans.size > 4) plans.delete(plans.keys().next().value as string);
  return made;
}

function tooLarge(text: string): boolean {
  // A UTF-16 unit is 1 to 3 UTF-8 bytes.
  if (text.length > MAX_DOC_BYTES) return true;
  if (text.length * 3 <= MAX_DOC_BYTES) return false;
  return new TextEncoder().encode(text).length > MAX_DOC_BYTES;
}

function makePlan(markdown: string): Plan {
  if (tooLarge(markdown)) return { html: convertedHtml(markdown), ok: false, reason: 'too-large' };
  const crlf = markdown.includes('\r');
  // Every line ends in CRLF, or none does. A mix saves with LF endings; its blocks still keep their spelling.
  if (crlf && (/\r(?!\n)/.test(markdown) || /(^|[^\r])\n/.test(markdown))) {
    const lf = markdown.replace(/\r\n?/g, '\n');
    return { html: sourcePlan(lf, false, parser.lexer(lf)).html, ok: false, reason: 'line-endings' };
  }
  const text = crlf ? markdown.replace(/\r\n/g, '\n') : markdown;
  // Lexing is the costliest step on a long file: once, for both paths.
  const tokens = parser.lexer(text);
  // The plain save trims the file, ends it with one newline and reads front matter as a rule and a
  // heading: a file it cannot give back skips the fast path.
  const plain = !crlf && /^\S/.test(text) && /[^\n]\n$/.test(text) && !frontMatter(text);
  if (plain) {
    // The fast path: the editor already writes this file as it is. marked's renderer changes
    // the tokens it renders (a loose task item takes its checkbox), so it renders a copy.
    const html = convertedHtml(text, structuredClone(tokens));
    if (saveDoc(throughSchema(html)).text === text) return { html, ok: true };
  }
  return sourcePlan(text, crlf, tokens);
}

/* ------------------------------------------------------------------------ */
/* Keeping the file's own spelling                                           */
/* ------------------------------------------------------------------------ */

/** One top-level block of the file. */
type Unit = {
  /** The block as the file spells it, without the blank lines around it. */
  text: string;
  /** The text between the previous block and this one (only whitespace). */
  gap: string;
  /** marked's token, or null for a block the editor cannot show (front matter, a definition, an HTML block). */
  token: Token | null;
};

/** How a block opens: as the editor writes it, with its source kept, or as raw Markdown text. */
type Shape = 'native' | 'kept' | 'raw';

/**
 * YAML front matter: `---` on the first line, a `key:` line under it, and a
 * closing `---` or `...` line. (`---` above a paragraph is a rule, not front matter.)
 */
function frontMatter(text: string): string | null {
  if (!text.startsWith('---\n') || !/^[A-Za-z_][\w-]*[ \t]*:/.test(text.slice(4))) return null;
  for (let at = 4; at < text.length; ) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl;
    if (/^(---|\.\.\.)[ \t]*$/.test(text.slice(at, end))) return text.slice(0, end);
    if (nl === -1) return null;
    at = nl + 1;
  }
  return null;
}

/** The file as top-level blocks and the whitespace around them: `gap₀ text₀ gap₁ text₁ … tail`. */
function splitUnits(text: string, tokens: Token[]): { units: Unit[]; tail: string } {
  const units: Unit[] = [];
  let pending = '';
  const front = frontMatter(text);
  if (front) units.push({ text: front, gap: '', token: null });
  for (const token of front ? parser.lexer(text.slice(front.length)) : tokens) {
    const lead = /^\n*/.exec(token.raw)?.[0] ?? '';
    const body = token.raw.slice(lead.length).replace(/[ \t\n]+$/, '');
    if (token.type === 'space' || !body) {
      pending += token.raw;
      continue;
    }
    const shown = token.type === 'def' ? false : token.type === 'html' ? DOC_HTML.test(body) : true;
    units.push({ text: body, gap: pending + lead, token: shown ? token : null });
    pending = token.raw.slice(lead.length + body.length);
  }
  return { units, tail: pending };
}

const standardGap = (index: number) => (index === 0 ? '' : '\n\n');
const STANDARD_END = '\n';

/** A unit's blocks as the editor parses them: its kinds, and what the editor writes for it. */
type Reading = { kinds: string[]; markdown: string[]; html: string };

function sourcePlan(text: string, crlf: boolean, tokens: Token[]): Plan {
  const { units, tail } = splitUnits(text, tokens);
  if (units.map((u) => u.gap + u.text).join('') + tail !== text) {
    // marked dropped or reordered text: nothing to anchor the blocks on.
    return { html: convertedHtml(text, tokens), ok: false, reason: 'unstable' };
  }
  const readings = readUnits(units);
  const needsAttribute = (i: number) =>
    crlf || units[i].gap !== standardGap(i) || (i === units.length - 1 && tail !== STANDARD_END);
  const shapes: Shape[] = units.map((unit, i) => {
    const reading = readings[i];
    if (!reading) return 'raw';
    // Several blocks (a paragraph the editor splits around an image) are kept together (`span`).
    return reading.markdown.join('\n\n') === unit.text && (reading.markdown.length === 1 || !needsAttribute(i)) ? 'native' : 'kept';
  });

  // Where each unit ends in the file.
  const ends: number[] = [];
  units.reduce((offset, u) => {
    ends.push(offset + u.gap.length + u.text.length);
    return ends[ends.length - 1];
  }, 0);
  // A block the editor still rewrites in context opens raw, one at a time from the first difference;
  // after three, every block from the difference on opens raw, so a file costs at most five passes.
  for (let attempt = 0; ; attempt++) {
    const html = assemble(units, tail, crlf, readings, shapes);
    const saved = saveDoc(throughSchema(html));
    if (saved.text === text && saved.crlf === crlf) return { html, ok: true };
    const at = firstDifference(saved.text, text);
    let index = ends.findIndex((end) => at < end);
    if (index === -1) index = units.length - 1;
    while (index >= 0 && shapes[index] === 'raw') index--;
    if (index < 0 || attempt === 4) return { html, ok: false, reason: 'unstable' };
    for (let i = index; i < (attempt < 3 ? index + 1 : units.length); i++) shapes[i] = 'raw';
  }
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/**
 * Each shown unit through marked and the editor's schema, in one pass: a
 * marker paragraph before each unit separates what the editor makes of it.
 */
function readUnits(units: Unit[]): Array<Reading | null> {
  const sections = renderUnits(units.map((u) => (u.token ? [u.token] : null)));
  const readings: Array<Reading | null> = units.map((u, i) => (u.token ? { kinds: [], markdown: [], html: sections[i] } : null));
  const opened = openSections(sections, units.map((u) => u.text));
  opened.forEach((blocks, i) => {
    const reading = readings[i];
    for (const block of reading ? blocks : []) {
      reading!.kinds.push(block.kind);
      reading!.markdown.push(block.markdown);
    }
  });
  return readings.map((r) => (r && r.markdown.length ? r : null));
}

/** Each unit's tokens as the HTML the editor opens (`''` for none): marked, soft breaks, media as blocks. */
function renderUnits(units: Array<Token[] | null>): string[] {
  const doc = new DOMParser().parseFromString(
    units.map((tokens) => `<section>${tokens ? editorHtml(parser.parser(tokens) as string) : ''}</section>`).join(''),
    'text/html',
  );
  markSoftBreaks(doc);
  const sections = Array.from(doc.body.children);
  sections.forEach(unwrapImageParagraph);
  return sections.map((s) => s.innerHTML);
}

/**
 * Sections of HTML through the editor's schema, in one pass: a marker
 * paragraph before each separates the blocks the editor makes of it (empty
 * blocks left out, as a save leaves them out). `texts`: the sources, which
 * the marker must not occur in.
 */
function openSections(sections: string[], texts: string[]): SavedBlock[][] {
  let marker = 'kxunit';
  while (texts.some((t) => t.includes(marker))) marker += Math.random().toString(36).slice(2, 6);
  const html = sections.map((s, i) => (s ? `<p>${marker}${i}</p>${s}` : '')).join('');
  const opened: SavedBlock[][] = sections.map(() => []);
  const isMarker = new RegExp(`^${marker}(\\d+)$`);
  let current: SavedBlock[] | null = null;
  for (const block of savedBlocks(throughSchema(html)) ?? []) {
    const index = block.kind === 'p' ? isMarker.exec(block.markdown)?.[1] : undefined;
    if (index !== undefined) current = opened[Number(index)] ?? null;
    else if (current && block.markdown) current.push(block);
  }
  return opened;
}

/**
 * Whether a kept source holds text the editor would not show: a link
 * reference definition, or a link with no text. A block of the file never
 * holds one (a definition is a block of its own, opened raw).
 */
function hidesText(tokens: Token[]): boolean {
  let hidden = false;
  parser.walkTokens(tokens, (token) => {
    if (token.type === 'def' || (token.type === 'link' && !token.text.trim())) hidden = true;
  });
  return hidden;
}

/**
 * Which kept sources open as exactly the blocks shown (their HTML through the
 * schema, `md` aside). A matching hash is cheap but proves nothing: a writer
 * or a paste can set `md`. `links`: the file's link definitions.
 */
function sourcesShown(candidates: Array<{ src: string; shown: string[] }>, links: Links): boolean[] {
  if (!candidates.length) return [];
  const tokens = candidates.map(({ src }) => {
    const lexer = new Lexer(parser.defaults);
    Object.assign(lexer.tokens.links, links);
    return lexer.lex(src);
  });
  const opened = openSections(renderUnits(tokens), candidates.map((c) => c.src));
  return candidates.map(
    ({ shown }, i) =>
      !hidesText(tokens[i]) && opened[i].length === shown.length && opened[i].every((block, j) => block.html === shown[j]),
  );
}

/** `<p><img></p>` → `<img>` (and a `<video>` line): media is a block in the editor, and its `md` must sit on it. */
function unwrapImageParagraph(section: Element) {
  const only = section.children.length === 1 ? section.firstElementChild : null;
  const media = only?.nodeName === 'P' && only.children.length === 1 ? only.firstElementChild : null;
  if (!only || !media || !['IMG', 'VIDEO'].includes(media.nodeName) || only.textContent?.trim()) return;
  only.replaceWith(media);
}

/** The editor's HTML for the file: each unit as the editor shows it, with what it must keep in `data-md`. */
function assemble(units: Unit[], tail: string, crlf: boolean, readings: Array<Reading | null>, shapes: Shape[]): string {
  const doc = new DOMParser().parseFromString('', 'text/html');
  const kinds = units.map((_u, i) => (shapes[i] === 'raw' ? ['raw'] : (readings[i]?.kinds ?? ['raw'])));
  const parts = units.map((unit, i) => {
    const md: MdBlock = {};
    if (unit.gap !== standardGap(i)) {
      md.gap = unit.gap;
      md.pair = `${i === 0 ? '^' : (kinds[i - 1].at(-1) ?? 'raw')}>${kinds[i][0]}`;
    }
    if (i === units.length - 1 && tail !== STANDARD_END) md.end = tail;
    if (crlf) md.crlf = true;
    const shape = shapes[i];
    const value = (extra: MdBlock = {}) => writeMd({ ...md, ...extra });
    if (shape === 'raw') {
      const attribute = value();
      return `<pre ${RAW_ATTRIBUTE}=""${attribute ? ` ${MD_ATTRIBUTE}="${escapeAttribute(attribute)}"` : ''}>${escapeHtml(unit.text)}</pre>`;
    }
    const reading = readings[i] as Reading;
    const { length } = reading.markdown;
    const attribute =
      shape === 'kept'
        ? value({ src: unit.text, norm: hashText(reading.markdown.join('\n\n')), ...(length > 1 ? { span: length } : {}) })
        : value();
    if (!attribute) return reading.html;
    const holder = doc.createElement('div');
    holder.innerHTML = reading.html;
    holder.firstElementChild?.setAttribute(MD_ATTRIBUTE, attribute);
    return holder.innerHTML;
  });
  if (!units.length && (tail !== STANDARD_END || crlf)) {
    // A file of whitespace alone: an empty paragraph holds its end.
    const attribute = writeMd({ ...(tail !== STANDARD_END ? { end: tail } : {}), ...(crlf ? { crlf: true as const } : {}) });
    return `<p ${MD_ATTRIBUTE}="${escapeAttribute(attribute ?? '')}"></p>`;
  }
  return parts.join('');
}

const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, '&quot;');

/* ------------------------------------------------------------------------ */
/* The editor's schema, without an editor                                    */
/* ------------------------------------------------------------------------ */

let schema: Schema | null = null;
const docSchema = () => (schema ??= getSchema(docExtensions({ editable: true, placeholder: () => '' })));

/** TipTap's `elementFromString`: it drops whitespace-only text nodes of a newline (and two spaces). */
function removeWhitespaces(node: Element) {
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i];
    if (child.nodeType === 3 && child.nodeValue && /^(\n\s\s|\n)$/.test(child.nodeValue)) node.removeChild(child);
    else if (child.nodeType === 1) removeWhitespaces(child as Element);
  }
}

/** HTML → the editor's document → `editor.getHTML()`, as TipTap does on load and on save. */
function throughSchema(html: string): string {
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  removeWhitespaces(dom.body);
  const node = ProseMirrorParser.fromSchema(docSchema()).parse(dom.body);
  const fragment = DOMSerializer.fromSchema(docSchema()).serializeFragment(node.content, { document: dom });
  const container = dom.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML;
}

/* ------------------------------------------------------------------------ */
/* Soft breaks                                                               */
/* ------------------------------------------------------------------------ */

const TEXT_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th';
const BLOCK_TAGS = new Set(['UL', 'OL', 'P', 'PRE', 'BLOCKQUOTE', 'TABLE', 'DIV', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CONTAINER_TAGS = new Set([...BLOCK_TAGS, 'LI', 'THEAD', 'TBODY', 'TR']);

/** Each newline inside a text block's text → `<span data-soft-break> </span>`. */
function markSoftBreaks(doc: Document) {
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    const parent = text.parentElement;
    if (!parent || !text.data.includes('\n') || parent.closest('pre, code')) continue;
    const block = parent.closest(TEXT_BLOCK);
    // Only text that flows in the block: not the newlines between a nested list's items.
    if (!block || (parent !== block && CONTAINER_TAGS.has(parent.nodeName))) continue;
    // A newline beside a block edge (before a nested list, at the item's end) is layout, not a break.
    const edge = (sibling: ChildNode | null) => (sibling ? BLOCK_TAGS.has(sibling.nodeName) : parent === block);
    let data = text.data;
    if (edge(text.nextSibling)) data = data.replace(/\n+$/, '');
    if (edge(text.previousSibling)) data = data.replace(/^\n+/, '');
    const pieces: Node[] = [];
    data.split('\n').forEach((part, i) => {
      if (i > 0) {
        const soft = doc.createElement('span');
        soft.setAttribute('data-soft-break', '');
        soft.textContent = ' ';
        pieces.push(soft);
      }
      if (part) pieces.push(doc.createTextNode(part));
    });
    text.replaceWith(...pieces);
  }
}

/* ------------------------------------------------------------------------ */
/* HTML → Markdown                                                           */
/* ------------------------------------------------------------------------ */

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    // A soft break holds only a space, so turndown sees it as blank: it saves as the newline it was.
    blankReplacement: (_content, node) =>
      node.nodeName === 'SPAN' && (node as HTMLElement).hasAttribute('data-soft-break')
        ? '\n'
        : (node as { isBlock?: boolean }).isBlock
          ? '\n\n'
          : '',
  });
  tables(td);
  strikethrough(td);
  // GFM's own strikethrough (`~~`), not the plugin's single tilde.
  td.addRule('strikethroughGfm', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  // Markdown has no underline: the editor's (⌘U) stays an HTML tag, which opens as underline again.
  td.addRule('underline', { filter: ['u'], replacement: (content) => (content.trim() ? `<u>${content}</u>` : content) });
  // An empty line inside a quote is a bare `>`.
  td.addRule('blockquote', {
    filter: 'blockquote',
    replacement: (content) =>
      `\n\n${content
        .replace(/^\n+|\n+$/g, '')
        .replace(/^/gm, '> ')
        .replace(/^> $/gm, '>')}\n\n`,
  });
  td.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim().replace(/\n+/g, ' ')}\n`,
  });
  // Tight items (`- a`, `1. a`), nested lines indented to the marker's width; an empty line stays empty.
  // Added after taskItem, so it would win (turndown tries later rules first): skip task items.
  td.addRule('listItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      const start = Number(parent?.getAttribute('start') ?? 1);
      const prefix = parent?.nodeName === 'OL' ? `${start + index}. ` : '- ';
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n(?=[^\n])/g, `\n${' '.repeat(prefix.length)}`);
      return `${prefix}${body}\n`;
    },
  });
  // An underscore inside a word (`feature_disabled`) never starts emphasis: keep it bare.
  const escape = td.escape.bind(td);
  td.escape = (text: string) => escape(text).replace(/(\w)\\_(?=\w)/g, '$1_');
  td.remove(['label']);
  // A video stays an HTML tag inside the Markdown: Markdown has none.
  td.keep(['video']);
  // A link card stays one line of HTML (doc-embed.tsx): a Markdown HTML block, served as written.
  td.addRule('linkEmbed', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).classList.contains('kx-embed'),
    replacement: (_content, node) => `\n\n${(node as HTMLElement).outerHTML.replace(/\s*\n\s*/g, ' ')}\n\n`,
  });
  // A raw block moved into a list or a quote: its text, as written.
  td.addRule('rawMarkdown', {
    filter: (node) => node.nodeName === 'PRE' && (node as HTMLElement).hasAttribute(RAW_ATTRIBUTE),
    replacement: (_content, node) => `\n\n${node.textContent ?? ''}\n\n`,
  });
  service = td;
  return td;
}

/** The editor's HTML, cleaned for turndown. */
function cleanedBody(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc);
  return doc.body;
}

function clean(doc: Document) {
  // A table cell holds one line in Markdown: unwrap the editor's paragraphs.
  doc.querySelectorAll('td > p, th > p').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  // A list item with one paragraph is one line: unwrap it, so the list stays tight.
  doc.querySelectorAll('li > p:only-of-type').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  doc.querySelectorAll('colgroup').forEach((c) => c.remove());
  // Media still uploading is a local preview: the file gets it once the upload lands.
  doc.querySelectorAll('[data-uploading]').forEach((el) => el.remove());
  // Empty, so turndown adds no flanking space: the soft break saves as a bare newline.
  doc.querySelectorAll('span[data-soft-break]').forEach((s) => {
    s.textContent = '';
  });
}

/** A top-level block: its kind, what the editor writes for it (no source kept), and its HTML as shown (`md` aside). */
type SavedBlock = { kind: string; markdown: string; md: MdBlock | null; raw: boolean; html: string };

/** Each top-level block of the editor's HTML. */
function savedBlocks(html: string): SavedBlock[] | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { body } = doc;
  const shown = new Map<Element, string>();
  for (const el of Array.from(body.children)) {
    const copy = el.cloneNode(true) as Element;
    copy.removeAttribute(MD_ATTRIBUTE);
    shown.set(el, copy.outerHTML);
  }
  clean(doc);
  // Text outside a block (not from the editor) has no block to belong to.
  if (Array.from(body.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())) return null;
  const elements = Array.from(body.children);
  const blocks = elements.map((el) => ({
    kind: blockKind(el),
    md: readMd(el),
    raw: el.hasAttribute(RAW_ATTRIBUTE),
    markdown: '',
    html: shown.get(el) ?? '',
  }));
  // `md` never reaches the file (a video and a link card save as their HTML).
  body.querySelectorAll(`[${MD_ATTRIBUTE}]`).forEach((el) => el.removeAttribute(MD_ATTRIBUTE));
  elements.forEach((el, i) => {
    blocks[i].markdown = blocks[i].raw ? (el.textContent ?? '') : turndown().turndown(el.outerHTML);
  });
  return blocks;
}

/** The editor's HTML → the file: `text` with LF line endings, and whether the file uses CRLF. */
function saveDoc(html: string): { text: string; crlf: boolean } {
  if (!html.includes(MD_ATTRIBUTE) && !html.includes(RAW_ATTRIBUTE)) return { text: plainMarkdown(html), crlf: false };
  const blocks = savedBlocks(html);
  if (!blocks) return { text: plainMarkdown(html), crlf: false };
  // An empty block (the editor's trailing paragraph) saves as nothing, as it always has.
  const shown = blocks.filter((b) => b.markdown);
  const kept = keptSources(shown);
  let text = '';
  let previous = '^';
  let last: MdBlock | null = null;
  for (let i = 0; i < shown.length; ) {
    const { md, kind } = shown[i];
    // The file's spelling of a block nobody edited, proven to open as the blocks shown.
    const count = kept.get(i) ?? 1;
    const markdown = kept.has(i) ? (md?.src as string) : shown[i].markdown;
    const gap = md?.gap !== undefined && LAYOUT_WHITESPACE.test(md.gap) && md.pair === `${previous}>${kind}` ? md.gap : i ? '\n\n' : '';
    text += gap + markdown;
    previous = shown[i + count - 1].kind;
    last = count > 1 ? md : shown[i].md;
    i += count;
  }
  const end = (shown.length ? last : blocks[0]?.md)?.end;
  return { text: text + (end !== undefined && LAYOUT_WHITESPACE.test(end) ? end : STANDARD_END), crlf: blocks.some((b) => b.md?.crlf) };
}

/**
 * The shown blocks whose kept source the file takes, by index → the number of
 * blocks it covers: the editor still writes `norm` for them (nobody edited
 * them), and the source opens as exactly these blocks (`sourcesShown`).
 */
function keptSources(shown: SavedBlock[]): Map<number, number> {
  const candidates: Array<{ index: number; span: number; src: string; shown: string[] }> = [];
  shown.forEach((block, index) => {
    const { md } = block;
    if (block.raw || typeof md?.src !== 'string') return;
    const span = Math.max(1, Number(md.span) || 1);
    const group = shown.slice(index, index + span);
    if (group.length === span && md.norm === hashText(group.map((b) => b.markdown).join('\n\n')))
      candidates.push({ index, span, src: md.src, shown: group.map((b) => b.html) });
  });
  if (!candidates.length) return new Map();
  // The file's link definitions (each a raw block), so a kept `[text][ref]` opens as its link.
  const definitions = shown.filter((b) => b.raw && /^ {0,3}\[[^\]]+\]:/.test(b.markdown)).map((b) => b.markdown);
  const links = definitions.length ? parser.lexer(definitions.join('\n\n')).links : {};
  const proven = sourcesShown(candidates, links);
  return new Map(candidates.filter((_c, i) => proven[i]).map((c) => [c.index, c.span]));
}

/** A document with nothing kept: one turndown pass, as the editor has always saved. */
function plainMarkdown(html: string): string {
  const body = cleanedBody(html);
  // A top-level image or video is a block: one blank line apart, like every block.
  body.querySelectorAll(':scope > img, :scope > video').forEach((el) => {
    const p = body.ownerDocument.createElement('p');
    el.replaceWith(p);
    p.appendChild(el);
  });
  return `${turndown().turndown(body.innerHTML).trim()}\n`;
}

export function htmlToMarkdown(html: string): string {
  const { text, crlf } = saveDoc(html);
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
