// The two artifact types. An artifact is a path in the project's Files volume:
//   doc   a Markdown file (`report.md`, or `index.md` in a folder). Kortix
//         renders it with one stylesheet (`@kortix/shared/artifact-doc`) and
//         people edit it in the app's doc editor
//   html  an HTML page (`page.html`, or `index.html` in a folder with its
//         assets) — a deck, a dashboard, a mockup, a tool — served as written
// `format` is the contract agents follow (the kortix-artifacts skill and
// `kortix artifacts types`); `starter` is a complete example.
import { ARTIFACT_DOC_CSS, ARTIFACT_PAGE_CSS } from '@kortix/shared/artifact-doc';
import { BRAND_FONTS_CSS, BRAND_TOKENS_CSS } from '@kortix/shared/brand-css';
import { marked } from 'marked';

export const ARTIFACT_TYPE_KEYS = ['doc', 'html'] as const;

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs';
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Untitled page</title>
<style>
  /* Layout: one centered reading column. Replace the tokens with this subject's own. */
  :root {
    --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --rule: #e4e3df; --accent: #2f5bd3;
    --font-display: ui-serif, Georgia, serif; --font-body: ui-sans-serif, system-ui, sans-serif;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151514; --fg: #ecebe7; --muted: #a09f99; --rule: #2c2c2a; --accent: #8aa8ff; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 var(--font-body); }
  main { max-width: 68ch; margin: 0 auto; padding-block: 48px; padding-inline: max(16px, 4vw); }
  h1 { font: 600 2.25rem/1.15 var(--font-display); text-wrap: balance; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  .muted { color: var(--muted); }
  img, video { max-width: 100%; height: auto; }
</style>
</head>
<body>
<main>
  <h1>Untitled page</h1>
  <p class="muted">Lead with the answer. Put images, scripts and data next to this file and load them by relative path.</p>
</main>
</body>
</html>
`;

export const ARTIFACT_TYPES = [
  {
    type: 'doc' as const,
    name: 'Doc',
    description: 'A document to read and edit: a spec, report, memo or plan. A Markdown file in Files; people edit it in place in Kortix.',
    format: [
      'A Markdown file (GitHub flavored). Start with one `# Title`. Kortix renders and styles it; add no HTML layout, CSS or scripts.',
      'Supported: headings, paragraphs, bold, italic, strikethrough, inline code, links, bulleted, numbered and task lists (`- [ ]`), blockquotes, code blocks, tables, horizontal rules, ```mermaid diagrams, images (`![alt](media/chart.png)` next to index.md, or an absolute URL) and videos (`<video src="media/demo.mp4" controls></video>`).',
      'Need layout, charts or interaction? Make an html artifact instead.',
    ].join('\n'),
    starter: DOC_STARTER,
  },
  {
    type: 'html' as const,
    name: 'HTML',
    description: 'Any page or bundle: a slide deck, a dashboard, a design mockup, a tool or an app.',
    format: [
      'A folder with index.html and its assets (scripts, styles, images, data, referenced by relative path). Publishing one .html file makes that folder for you. Served exactly as written: write the doctype, the viewport meta and the <title> yourself.',
      'The page runs sandboxed: no cookies, storage may throw (wrap it in try/catch), no access to Kortix. Load libraries from a CDN (cdnjs, jsdelivr, unpkg) at a pinned version when they do real work.',
      'Make it work from 400px wide to a large screen with no sideways scroll, and in light and dark: every color a token on :root, redefined under prefers-color-scheme: dark.',
      'The design method (treatment, token plan, charts, copy, naming) is in the kortix-artifacts skill, references/design.md.',
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
  // ```mermaid blocks render as diagrams (the CDN build, pinned); print waits for them.
  const diagrams = body.includes('class="language-mermaid"');
  const html = (diagrams ? body.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, '<pre class="mermaid">$1</pre>') : body)
    // The chrome UnifiedMarkdown gives code and tables: a captioned code figure, a bordered table box.
    .replace(/<pre><code(?: class="language-([\w+#-]+)")?>/g, (_m, lang?: string) => `<figure class="kx-code"><figcaption>${lang ?? 'text'}</figcaption><pre><code>`)
    .replace(/<\/code><\/pre>/g, '</code></pre></figure>')
    .replace(/<table>/g, '<div class="kx-table"><table>')
    .replace(/<\/table>/g, '</table></div>');
  const mermaid = diagrams
    ? `<script type="module">import m from "${MERMAID_CDN}";m.initialize({startOnLoad:false,securityLevel:"strict",theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"neutral",fontFamily:getComputedStyle(document.body).fontFamily});await m.run();window.__kxDiagrams=true;</script>`
    : '';
  const print = opts.print
    ? `<script>addEventListener("load",function(){var t=Date.now();(function go(){if(${diagrams ? '!window.__kxDiagrams&&' : ''}Date.now()-t<8000)return setTimeout(go,150);setTimeout(function(){print()},300)})()})</script>`
    : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>${BRAND_FONTS_CSS}${BRAND_TOKENS_CSS}${ARTIFACT_PAGE_CSS}${ARTIFACT_DOC_CSS}</style>${mermaid}${print}</head>\n<body><main class="kx-doc">\n${html}</main></body></html>\n`;
}

/** A doc's title: its first `# ` heading. */
export function docTitle(markdown: string): string | null {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || null;
}

/** An HTML page's <title>. */
export function htmlTitle(html: string): string | null {
  return /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() || null;
}
