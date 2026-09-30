/**
 * Agent-minted setup links in assistant prose: a `/connect/<token>` link
 * (connect an app) or a `/secret-intake/<token>` link (enter a secret).
 *
 * Web intercepts these in its markdown link renderer
 * (`apps/web/src/components/setup-links/util.ts`, `markdown/setup-link-blocks.ts`)
 * and draws a card. The mobile renderer draws every link inside a `Text`, which
 * cannot hold a full-width row, so the text is cut around the link instead:
 * `splitSetupLinks` returns markdown segments and card segments in order, and
 * `TextPartBlock` renders one after the other.
 *
 * The app has no origin of its own, so a link counts only when its token has
 * the `ksl_` wire prefix (`apps/api/src/setup-links/token.ts`) — web's rule for
 * a cross-origin link.
 */
import { autoLinkUrls, openMarkdownLinkAtEnd } from '@kortix/shared';

export type SetupLinkKind = 'secret' | 'connector';

export type SetupLinkSegment =
  | { type: 'markdown'; text: string }
  | {
      type: 'setup';
      kind: SetupLinkKind;
      /** Null while the link's URL is still streaming. */
      token: string | null;
      href: string | null;
      /** The app (connector) or the ask (secret) the agent's text names. May be empty. */
      label: string;
    };

const SETUP_URL = String.raw`https?:\/\/[^/\s<>()\[\]]+\/(secret-intake|connect)\/(ksl_[\w-]+)`;
/** Query, fragment, and prose punctuation after a bare URL. */
const URL_TAIL = String.raw`[^\s<>()\[\]\x60|]*`;
/** The destination a setup link carries while its URL is still streaming (web's fragment). */
const PENDING_HREF = '#kortix-setup-link-pending:';

const SETUP_HREF = new RegExp(`^${SETUP_URL}(?:[?#].*)?$`);
const PARTIAL_SETUP_URL = /^https?:\/\/[^/\s]+\/(secret-intake|connect)\/([\w-]*)$/;
/** `[label](url)`, `[label](pending)`, or a bare, `<…>` or `` `…` `` wrapped URL. */
const SETUP_LINK = new RegExp(
  String.raw`\[([^\]\n]*)\]\((?:${SETUP_URL}${URL_TAIL}|${PENDING_HREF}(secret|connector))\)` +
    String.raw`|[<\x60]?${SETUP_URL}${URL_TAIL}[>\x60]?`,
  'g',
);

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** Separators an agent puts between a label and its link. */
const LABEL_NOISE = /[\s:|–—\-•·*_()>#.,!]+/g;
/** Text worth keeping beside a card: a lone "." or "**" is not. */
const HAS_WORD = /[\p{L}\p{N}]/u;
/** Past this length the text beside a link is content, not a label (web's `MAX_LABEL_CHARS`). */
const MAX_LABEL_CHARS = 40;

const kindOf = (route: string): SetupLinkKind => (route === 'secret-intake' ? 'secret' : 'connector');

export function parseSetupLinkHref(href: unknown): { kind: SetupLinkKind; token: string } | null {
  const match = typeof href === 'string' ? href.trim().match(SETUP_HREF) : null;
  return match ? { kind: kindOf(match[1]), token: match[2] } : null;
}

/** The kind of setup link a URL that is still streaming will become, or null. */
function partialSetupLinkKind(partial: string): SetupLinkKind | null {
  const match = partial.trim().match(PARTIAL_SETUP_URL);
  if (!match) return null;
  const token = match[2];
  return 'ksl_'.startsWith(token) || token.startsWith('ksl_') ? kindOf(match[1]) : null;
}

/**
 * Streaming text that ends inside a markdown link, with that link held.
 *
 * A setup token is several hundred characters, so its link streams for a
 * second or two. Until the closing paren arrives the open link is rewritten:
 * a setup link to its pending destination (the card it will become, with
 * nothing to tap), any other link to `[label](#)` (its label in link style).
 * The raw `[label](https://…` text never shows.
 */
export function holdStreamingLink(markdown: string): string {
  const open = openMarkdownLinkAtEnd(markdown);
  // A label with brackets inside cannot be re-emitted safely.
  if (!open || open.label.includes('[') || open.label.includes(']')) return markdown;
  const head = markdown.slice(0, open.start);
  const kind = partialSetupLinkKind(open.destination ?? open.label);
  // A label that is the URL names nothing: the card shows its fallback title.
  if (kind) return `${head}[${open.destination === null ? '' : open.label}](${PENDING_HREF}${kind})`;
  return open.destination === null ? markdown : `${head}[${open.label}](#)`;
}

/** The link's own text, or the label beside it when that names the app better. */
function cardLabel(own: string, beside: string, kind: SetupLinkKind): string {
  const text = own.trim();
  const isUrl = /^https?:\/\//i.test(text) || text.includes('/connect/') || text.includes('/secret-intake/');
  const named =
    beside && (isUrl || !text.toLowerCase().includes(beside.toLowerCase())) ? beside : isUrl ? '' : text;
  return kind === 'connector' ? named.replace(/^connect(?:\s+|$)/i, '').trim() : named;
}

/**
 * Cuts assistant markdown around its setup links.
 *
 * - A list item or an `App | Link` table row that is only a short label and
 *   its link becomes the card alone (web's `liftSetupLinkBlocks`). The card
 *   names the app itself, so the label would repeat it. A table whose rows are
 *   all such rows loses its header too.
 * - Anywhere else the text around the link stays, and the card stands where
 *   the link stood. Text already on screen never disappears mid-stream.
 * - A table row that carries more than a label stays a table, and its link
 *   stays a plain link.
 * - Fenced code is never touched.
 *
 * `streaming` holds the link at the end of the text (`holdStreamingLink`) and
 * treats a bare URL at the very end as pending, because its token may be cut.
 * A pending card and the finished card are the same segment, so the card turns
 * live in place.
 */
export function splitSetupLinks(markdown: string, streaming = false): SetupLinkSegment[] {
  const text = streaming ? holdStreamingLink(markdown) : markdown;
  if (!text.includes('/connect/') && !text.includes('/secret-intake/') && !text.includes(PENDING_HREF)) {
    return [{ type: 'markdown', text }];
  }

  const segments: SetupLinkSegment[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const joined = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined.trim()) segments.push({ type: 'markdown', text: joined });
    buffer = [];
  };

  const lines = text.split('\n');
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = line.match(FENCE)?.[1][0];
    if (marker && (fence === null || fence === marker)) fence = fence === null ? marker : null;
    const matches = marker || fence ? [] : [...line.matchAll(SETUP_LINK)];
    if (matches.length === 0) {
      buffer.push(line);
      return;
    }

    let outside = '';
    let cursor = 0;
    for (const match of matches) {
      outside += line.slice(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    outside += line.slice(cursor);
    const beside = outside.replace(LIST_MARKER, '').replace(LABEL_NOISE, ' ').trim();
    const isRow = TABLE_ROW.test(line);
    const isHolder = (isRow || LIST_MARKER.test(line)) && beside.length <= MAX_LABEL_CHARS;

    const card = (match: RegExpMatchArray, labelBeside: string): SetupLinkSegment => {
      const written = match[0];
      const bare = match[1] === undefined;
      const kind = (match[4] as SetupLinkKind | undefined) ?? kindOf(match[2] ?? match[5]);
      // A bare URL that ends the stream may still be growing.
      const cut = bare && streaming && index === lines.length - 1 && match.index! + written.length === line.length;
      const pending = match[4] !== undefined || cut;
      const href = bare
        ? written.replace(/^[<`]|[>`.,;:!?*_'"]+$/g, '')
        : written.slice(written.indexOf('](') + 2, -1);
      return {
        type: 'setup',
        kind,
        token: pending ? null : (match[3] ?? match[6]),
        href: pending ? null : href,
        label: cardLabel(match[1] ?? '', labelBeside, kind),
      };
    };

    if (isHolder) {
      // The first lifted row of a table takes the header with it.
      if (isRow && TABLE_DELIMITER.test(buffer[buffer.length - 1] ?? '') && TABLE_ROW.test(buffer[buffer.length - 2] ?? '')) {
        buffer.length -= 2;
      }
      flush();
      for (const match of matches) segments.push(card(match, matches.length === 1 ? beside : ''));
      return;
    }
    // ponytail: a row with real content keeps its table and its plain link; a
    // table mixing such rows with label-only rows renders in pieces. Parse the
    // table as a whole if agents start writing that shape.
    if (isRow) {
      buffer.push(line);
      return;
    }
    cursor = 0;
    for (const match of matches) {
      const before = line.slice(cursor, match.index).trimEnd();
      if (HAS_WORD.test(before)) buffer.push(before);
      flush();
      segments.push(card(match, ''));
      cursor = match.index! + match[0].length;
    }
    const after = line.slice(cursor).trimStart();
    if (HAS_WORD.test(after)) buffer.push(after);
  });
  flush();
  return segments;
}

/**
 * Assistant prose, ready to render: cut around its setup links, with every
 * bare URL and email in the remaining markdown turned into a link
 * (`autoLinkUrls`, the step web's `unified-markdown-utils.ts` runs). The
 * renderer's markdown-it does not linkify, so a bare URL was plain text that
 * could not be tapped.
 */
export function assistantSegments(markdown: string, streaming = false): SetupLinkSegment[] {
  return splitSetupLinks(markdown, streaming).map((segment) =>
    segment.type === 'markdown' ? { ...segment, text: autoLinkUrls(segment.text) } : segment,
  );
}
