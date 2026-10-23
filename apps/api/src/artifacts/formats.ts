// The two artifact types. An artifact is a path in the project's Files volume:
//   doc   a Markdown file (`report.md`, or `index.md` in a folder). Kortix
//         renders it with one stylesheet (`@kortix/shared/artifact-doc`) and
//         people edit it in the app's doc editor
//   html  an HTML page (`page.html`, or `index.html` in a folder with its
//         assets) — a deck, a dashboard, a mockup, a tool — served as written
// `format` is the contract agents follow (the kortix-artifacts skill and
// `kortix artifacts types`); `starter` is a complete example.
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { marked } from 'marked';

export const ARTIFACT_TYPE_KEYS = ['doc', 'html'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPE_KEYS)[number];

/** The type of an entry file, or null when it is neither. */
export function typeOfEntry(name: string): ArtifactType | null {
  if (/\.(md|markdown)$/i.test(name)) return 'doc';
  if (/\.html?$/i.test(name)) return 'html';
  return null;
}

const DOC_STARTER = `# Untitled doc

Write the answer first, in one or two sentences.
`;

const HTML_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled page</title>
<style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
  body{max-width:720px;margin:0 auto;padding:64px 24px;line-height:1.6}
  h1{font-size:2.25rem;letter-spacing:-.02em;margin:0 0 .5rem}
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
    description: 'A document to read and edit: a spec, report, memo or plan. A Markdown file in Files; people edit it in place in Kortix.',
    format: [
      'A Markdown file (GitHub flavored). Start with one `# Title`. Kortix renders and styles it; add no HTML layout, CSS or scripts.',
      'Supported: headings, paragraphs, bold, italic, strikethrough, inline code, links, bulleted, numbered and task lists (`- [ ]`), blockquotes, code blocks, tables, images (an absolute URL) and horizontal rules.',
      'Need layout, charts or interaction? Make an html artifact instead.',
    ].join('\n'),
    starter: DOC_STARTER,
  },
  {
    type: 'html' as const,
    name: 'HTML',
    description: 'Any page or bundle: a slide deck, a dashboard, a design mockup, a tool or an app.',
    format: [
      'A folder with index.html and its assets (scripts, styles, images, data, referenced by relative path), or one self-contained .html file. Served exactly as written.',
      'The page runs sandboxed: no cookies, no localStorage, no access to Kortix. Load libraries from a CDN (cdnjs, jsdelivr, unpkg) when you need them.',
      'Make it work from 360px wide to a large screen, in light and dark.',
    ].join('\n'),
    starter: HTML_STARTER,
  },
];

/** A Markdown doc as the page Kortix serves: GFM, task lists, the doc stylesheet; `print` opens the print dialog. */
export function renderDoc(markdown: string, opts: { print: boolean }): string {
  const body = (marked.parse(markdown, { gfm: true, async: false }) as string)
    .replace(/<li><input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}"><input type="checkbox" disabled${checked ? ' checked' : ''}> `)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1');
  const title = docTitle(markdown) ?? 'Untitled doc';
  const escaped = title.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const print = opts.print ? '<script>addEventListener("load",function(){setTimeout(function(){print()},400)})</script>' : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>${ARTIFACT_DOC_CSS}</style>${print}</head>\n<body class="kx-doc">\n${body}</body></html>\n`;
}

/** A doc's title: its first `# ` heading. */
export function docTitle(markdown: string): string | null {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || null;
}

/** An HTML page's <title>. */
export function htmlTitle(html: string): string | null {
  return /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() || null;
}
