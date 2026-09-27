import { defaultUrlTransform } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * Reproduces what the page's former `<ReactMarkdown>` did after sanitizing:
 * `urlTransform` on every href/src, and its `a` override — which kept only
 * `href` and opened every link in a new tab.
 */
function rehypeReleaseLinks() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === 'element' && node.properties) {
        for (const key of ['href', 'src'] as const) {
          const value = node.properties[key];
          if (value !== undefined && value !== null) {
            node.properties[key] = defaultUrlTransform(String(value));
          }
        }
        if (node.tagName === 'a') {
          const href = node.properties.href;
          node.properties = {
            ...(href !== undefined ? { href } : {}),
            target: '_blank',
            rel: ['noopener', 'noreferrer'],
          };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // Same options react-markdown passes: raw HTML becomes `raw` nodes, which
  // rehype-sanitize then drops. Nothing unsanitized reaches the output.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeSanitize)
  .use(rehypeReleaseLinks)
  .use(rehypeStringify);

/**
 * Renders one GitHub release body (GFM) to sanitized HTML — the same pipeline
 * the page ran through `<ReactMarkdown>` on every request, now run once per
 * cache fill. The output is safe for `dangerouslySetInnerHTML`: rehype-sanitize
 * uses GitHub's own allowlist, the same schema github.com renders these notes
 * with.
 */
export async function renderReleaseMarkdown(markdown: string): Promise<string> {
  return String(await processor.process(markdown));
}
