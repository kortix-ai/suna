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
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** The repo the release notes come from. `releases.ts` re-exports it. */
export const CHANGELOG_REPO = 'kortix-ai/suna';

/** `#10786` in prose: a pull request number, not part of a word or entity. */
const PR_REF = /(^|[^\w&#])#(\d{1,6})\b/g;

/**
 * Turns every `#1234` in the notes' text into a link to that pull request on
 * GitHub (GitHub redirects a number that is an issue). Text already inside a
 * link or code is left alone. The link carries `data-pr`, so the prose styles
 * can keep it in the text colour and only tint it on hover.
 */
function rehypePullLinks() {
  const skip = new Set(['a', 'code', 'pre']);
  const split = (value: string): HastNode[] => {
    const out: HastNode[] = [];
    let last = 0;
    for (const match of value.matchAll(PR_REF)) {
      const start = match.index + match[1].length;
      if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
      out.push({
        type: 'element',
        tagName: 'a',
        properties: {
          href: `https://github.com/${CHANGELOG_REPO}/pull/${match[2]}`,
          target: '_blank',
          rel: ['noopener', 'noreferrer'],
          dataPr: '',
        },
        children: [{ type: 'text', value: `#${match[2]}` }],
      });
      last = start + match[2].length + 1;
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out;
  };
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children || (node.tagName && skip.has(node.tagName))) return;
      node.children = node.children.flatMap((child) =>
        child.type === 'text' && child.value?.includes('#') ? split(child.value) : [child],
      );
      node.children.forEach(walk);
    };
    walk(tree);
  };
}

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
  .use(rehypePullLinks)
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
