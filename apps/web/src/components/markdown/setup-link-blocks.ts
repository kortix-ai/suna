import { parsePendingSetupLinkHref, parseSetupLinkHref } from '@/components/setup-links/util';

/**
 * The slice of an mdast node this transform reads. Declared here rather than
 * imported from `@types/mdast`, which `apps/web` does not depend on.
 */
export interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
}

/**
 * A row or item may carry a short label beside its link ("HubSpot", "**Canva**:")
 * and still be nothing but a holder for that link. Past this length the text is
 * content the author meant the reader to see, and the block stays as written.
 */
const MAX_LABEL_CHARS = 40;

/** Separators an agent puts between a label and its link. */
const LABEL_NOISE = /[\s:|–—\-•·*_()]+/g;

function isSetupLink(node: MdNode): boolean {
  return (
    node.type === 'link' &&
    (parseSetupLinkHref(node.url) !== null || parsePendingSetupLinkHref(node.url) !== null)
  );
}

/** Every setup link under `node`, and the plain text outside them. */
function splitLinks(node: MdNode): { links: MdNode[]; text: string } {
  const links: MdNode[] = [];
  let text = '';
  const walk = (current: MdNode) => {
    if (isSetupLink(current)) {
      links.push(current);
      return;
    }
    if (typeof current.value === 'string') text += ` ${current.value}`;
    current.children?.forEach(walk);
  };
  walk(node);
  return { links, text: text.replace(LABEL_NOISE, ' ').trim() };
}

function textOf(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

/**
 * The one setup link a row or item holds, relabelled by the text beside it when
 * the link's own text does not name the app (`[Connect](…)`, or a bare URL whose
 * text is the token). Null when the holder is more than a label and a link.
 */
function liftedLink(holder: MdNode): MdNode | null {
  const { links, text } = splitLinks(holder);
  if (links.length !== 1 || text.length > MAX_LABEL_CHARS) return null;
  const [link] = links;
  const own = textOf(link).trim();
  const namesApp = text === '' || own.toLowerCase().includes(text.toLowerCase());
  const looksLikeUrl = /^https?:\/\//i.test(own) || own.includes('/connect/');
  if (text !== '' && (!namesApp || looksLikeUrl)) {
    return { ...link, children: [{ type: 'text', value: text }] };
  }
  return link;
}

function liftTable(table: MdNode): MdNode[] | null {
  const rows = (table.children ?? []).slice(1);
  if (rows.length === 0) return null;
  const lifted: MdNode[] = [];
  for (const row of rows) {
    // A second non-empty cell beside the label is data (a reason, a scope), and
    // lifting would drop it.
    const cellsWithText = (row.children ?? []).filter(
      (cell) => splitLinks(cell).links.length === 0 && textOf(cell).trim() !== '',
    );
    if (cellsWithText.length > 1) return null;
    const link = liftedLink(row);
    if (!link) return null;
    lifted.push(link);
  }
  return lifted;
}

function liftList(list: MdNode): MdNode[] | null {
  const items = list.children ?? [];
  if (items.length === 0) return null;
  const lifted: MdNode[] = [];
  for (const item of items) {
    const link = liftedLink(item);
    if (!link) return null;
    lifted.push(link);
  }
  return lifted;
}

/**
 * Lifts setup links out of the table or list an agent wrapped them in.
 *
 * Every setup link renders as a full-width card (`SetupLinkButton`). An agent
 * asked for several apps reliably writes them as an `App | Link` table or a
 * bullet list, so each card landed inside a table cell or behind a bullet, next
 * to a column that repeated the app's name. The table added nothing the card did
 * not already say.
 *
 * A table or list whose rows are ONLY a label and one setup link is replaced by
 * a single paragraph of those links, which renders as a plain stack of cards —
 * the same card a lone link gets. Anything carrying more than that (a reason
 * column, a sentence of context, a row without a link) is left as written, and
 * its links render inline (see `SetupLinkInlineContext`).
 *
 * Top-level blocks only: Streamdown hands each top-level block to the parser on
 * its own, and a setup-link table nested in a blockquote is not a shape agents
 * produce.
 */
export function liftSetupLinkBlocks(tree: MdNode): void {
  if (!tree.children) return;
  tree.children = tree.children.map((block) => {
    const links =
      block.type === 'table' ? liftTable(block) : block.type === 'list' ? liftList(block) : null;
    return links ? { type: 'paragraph', children: links } : block;
  });
}

/** `liftSetupLinkBlocks` as a remark plugin. */
export function remarkSetupLinkBlocks() {
  return (tree: MdNode) => liftSetupLinkBlocks(tree);
}
