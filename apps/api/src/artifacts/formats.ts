// The two artifact types. An artifact is HTML either way:
//   doc   a document: semantic HTML (or Markdown on publish), styled by Kortix
//         with one stylesheet (`@kortix/shared/artifact-doc`) and edited in
//         the app's doc editor
//   html  any page or bundle — a deck, a dashboard, a mockup, a tool — served
//         exactly as written
// `format` is the contract agents follow (the kortix-artifacts skill and
// `kortix artifacts types`); `starter` is a complete example and the "start
// blank" page.
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { marked } from 'marked';

export const ARTIFACT_TYPE_KEYS = ['doc', 'html'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPE_KEYS)[number];

const DOC_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled doc</title></head>
<body>
<h1>Untitled doc</h1>
<p></p>
</body></html>
`;

const HTML_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled page</title>
<style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
  body{max-width:720px;margin:0 auto;padding:64px 24px;line-height:1.6}
  h1{font-size:2.25rem;letter-spacing:-.02em;margin:0 0 .5rem}
  p{color:#666}
</style></head>
<body>
<h1>Untitled page</h1>
<p>Any HTML, CSS and JavaScript. Put images, scripts and data next to this file.</p>
</body></html>
`;

export const ARTIFACT_TYPES = [
  {
    type: 'doc' as const,
    name: 'Doc',
    description: 'A document to read and edit: a spec, report, memo or plan. People edit it in place in Kortix.',
    format: [
      'Publish a Markdown file (`report.md`) or an HTML page with semantic content only. Kortix styles it; add no CSS and no scripts.',
      'Supported: headings, paragraphs, bold, italic, strikethrough, inline code, links, bulleted, numbered and task lists (`- [ ]`), blockquotes, code blocks, tables, images (an absolute URL or a file published beside the doc) and horizontal rules.',
      'Start with one `# Title`. Anything else (layout, colors, custom elements) is dropped when someone edits the doc: use the html type for that.',
    ].join('\n'),
    starter: DOC_STARTER,
  },
  {
    type: 'html' as const,
    name: 'HTML',
    description: 'Any page or bundle: a slide deck, a dashboard, a design mockup, a tool or an app.',
    format: [
      'Any HTML, CSS and JavaScript, served exactly as written. Supporting files (scripts, styles, images, data) are published beside index.html and referenced by relative path.',
      'The page runs sandboxed: no cookies, no localStorage, no access to Kortix. Load libraries from a CDN (cdnjs, jsdelivr, unpkg) when you need them.',
      'Make it work from 360px wide to a large screen, in light and dark. "Download PDF" prints the page: add `@media print` rules for decks and dashboards.',
    ].join('\n'),
    starter: HTML_STARTER,
  },
];

/** The entry page as served: a doc gets the doc stylesheet; `print` opens the print dialog (PDF). */
export function renderEntry(html: string, type: string, opts: { print: boolean }): string {
  let out = html;
  if (type === 'doc') {
    out = insertIntoHead(out, `<meta name="viewport" content="width=device-width,initial-scale=1"><style data-kortix-doc>${ARTIFACT_DOC_CSS}</style>`);
    out = /<body\b[^>]*>/i.test(out) ? out.replace(/<body\b([^>]*)>/i, '<body$1 class="kx-doc">') : `<body class="kx-doc">${out}</body>`;
  }
  if (opts.print) {
    out = insertIntoHead(out, '<script>addEventListener("load",function(){setTimeout(function(){print()},400)})</script>');
  }
  return out;
}

function insertIntoHead(html: string, tags: string): string {
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length) : tags + html;
}

/** A Markdown doc as the HTML page Kortix stores: GFM, task lists in the editor's shape. */
export function markdownDoc(markdown: string): string {
  const body = (marked.parse(markdown, { gfm: true, async: false }) as string)
    .replace(/<li><input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">`)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1');
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? 'Untitled doc';
  const escaped = title.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escaped}</title></head>\n<body>\n${body}</body></html>\n`;
}
