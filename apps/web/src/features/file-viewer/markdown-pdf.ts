import { parseFrontmatter, type FrontmatterValue } from '@/components/markdown/markdown-frontmatter';
import { katexRehypePluginsNoRaw, katexRemarkPlugins } from '@/components/markdown/katex-markdown';
import { prepareMarkdownSource } from '@/components/markdown/unified-markdown-utils';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * Markdown file → the HTML a PDF is printed from.
 *
 * The PDF is made from the RENDERED document, not the raw text: the same parse
 * rules the preview uses (`UnifiedMarkdown` with `trust="agent"`,
 * `variant="document"`) — GFM tables and task lists, `$…$` math, embedded HTML
 * dropped, then GitHub's sanitize schema. Only the renderer differs: static HTML
 * instead of React components, styled for paper by `app/print.css`.
 *
 * Pure and DOM-free, so the whole decision is unit-tested; the browser half
 * (mount, wait for images, `window.print()`) is `print-document.ts`.
 */

/**
 * Past this many characters the export refuses and points at the Markdown
 * download instead. The parse runs on the main thread and grows faster than
 * the input: measured under Bun on a mixed prose/list/table/code document,
 * 250K characters took ~0.6s, 500K ~1.2s, 1M ~6.8s and 2M ~15s. 500K is
 * roughly 150 printed pages. The raw file download has no such ceiling.
 */
export const MARKDOWN_PDF_MAX_CHARS = 500_000;

export type MarkdownPdfBlocker = 'empty' | 'too-large' | null;

/** Why this content cannot become a PDF, or null when it can. */
export function markdownPdfBlocker(content: string | null | undefined): MarkdownPdfBlocker {
  if (!content || !content.trim()) return 'empty';
  if (content.length > MARKDOWN_PDF_MAX_CHARS) return 'too-large';
  return null;
}

/**
 * The print document's title. Browsers name the saved PDF after the page title
 * (`<title>.pdf`), so `notes.md` must title the page `notes`, never
 * `notes.md` — that would save as `notes.md.pdf`.
 */
export function pdfDocumentTitle(fileName: string): string {
  const base = fileName.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem || 'document';
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Same image rewrite the preview applies (`MarkdownImage` → `proxy(src) ?? src`). */
function rehypeResolveImages(options: { resolve?: (src: string) => string | undefined }) {
  return (tree: HastNode) => {
    const resolve = options.resolve;
    if (!resolve) return;
    const walk = (node: HastNode) => {
      if (node.tagName === 'img' && typeof node.properties?.src === 'string') {
        node.properties.src = resolve(node.properties.src) ?? node.properties.src;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function frontmatterValue(value: FrontmatterValue): string {
  if (typeof value === 'string') return value;
  return Object.entries(value)
    .map(([key, nested]) => `${key}: ${nested}`)
    .join(', ');
}

/**
 * The preview shows frontmatter as a key/value card above the body. Paper gets
 * the same facts as a two-column table. Built here, outside the markdown
 * pipeline, so every value is escaped by hand.
 */
function frontmatterTable(frontmatter: Record<string, FrontmatterValue> | null): string {
  if (!frontmatter) return '';
  const rows = Object.entries(frontmatter).map(
    ([key, value]) =>
      `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(frontmatterValue(value))}</td></tr>`,
  );
  if (rows.length === 0) return '';
  return `<table data-print-frontmatter=""><tbody>${rows.join('')}</tbody></table>`;
}

/**
 * Markdown → sanitized HTML for the print document.
 *
 * `resolveImageSrc` is the preview's sandbox proxy, so an image the preview
 * shows is the image the PDF shows.
 */
export async function renderMarkdownForPrint(
  markdown: string,
  options: { resolveImageSrc?: (src: string) => string | undefined } = {},
): Promise<string> {
  // Frontmatter comes off before the parser sees it, exactly as
  // `MarkdownWithFrontmatter` does — otherwise `---` reads as a rule and the
  // metadata as one giant setext heading.
  const { frontmatter, body } = parseFrontmatter(markdown);
  const html = await unified()
    .use(remarkParse)
    .use(katexRemarkPlugins)
    // Raw HTML becomes `raw` nodes, which the sanitizer then drops: a markdown
    // FILE never turns embedded markup into live DOM (`variant="document"`).
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(katexRehypePluginsNoRaw)
    .use(rehypeResolveImages, { resolve: options.resolveImageSrc })
    .use(rehypeStringify)
    .process(prepareMarkdownSource(body, false));
  return frontmatterTable(frontmatter) + String(html);
}
