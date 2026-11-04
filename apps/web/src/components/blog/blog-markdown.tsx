import { BlockView } from '@/components/blog/blog-content';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { parseRichBlock, RICH_BLOCKS } from '@/lib/rich-blocks';

/**
 * A post's Markdown body, rendered by the app's one markdown renderer
 * (`UnifiedMarkdown`): the same text size, headings, lists, links, code
 * chips, highlighted code blocks, quotes and tables as everywhere else.
 *
 * A fenced block whose language is a rich block type (```compare, ```verdict,
 * ```logos, ```cta) is cut out of the Markdown and rendered as that block,
 * with its YAML body as the data. Prose keeps a reading measure; rich blocks
 * take the article's full width.
 */

/** A rich fence on its own lines: ```compare … ```. */
const RICH_FENCE = /^```([\w-]+)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

type Segment = { kind: 'markdown'; text: string } | { kind: 'rich'; lang: string; source: string };

function splitRichBlocks(body: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of body.matchAll(RICH_FENCE)) {
    const [whole, lang, source] = match;
    if (!RICH_BLOCKS.has(lang)) continue;
    const text = body.slice(last, match.index).trim();
    if (text) segments.push({ kind: 'markdown', text });
    segments.push({ kind: 'rich', lang, source });
    last = match.index + whole.length;
  }
  const rest = body.slice(last).trim();
  if (rest) segments.push({ kind: 'markdown', text: rest });
  return segments;
}

export function BlogMarkdown({ lead, body }: { lead?: string; body: string }) {
  return (
    <div className="mt-10">
      {lead && (
        <div className="max-w-3xl">
          <BlockView block={{ type: 'lead', text: lead }} />
        </div>
      )}
      {splitRichBlocks(body).map((segment, i) =>
        segment.kind === 'rich' ? (
          <BlockView key={i} block={parseRichBlock(segment.lang, segment.source)} />
        ) : (
          // Posts are written by the team: trusted, rendered as a document (no raw HTML).
          <UnifiedMarkdown key={i} content={segment.text} trust="trusted" variant="document" className="my-6 max-w-3xl" />
        ),
      )}
    </div>
  );
}
