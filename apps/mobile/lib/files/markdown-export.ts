/**
 * Markdown download formats (KRTX-605). A markdown file downloads as itself
 * (`file`) or as a PDF (`pdf`); every other file downloads as itself.
 *
 * Pure: no React Native import, so `bun test` covers it. The PDF itself is
 * written by `export-markdown-pdf.ts` with `expo-print`.
 */

export type DownloadFormat = 'file' | 'pdf';

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

export function downloadFormats(name: string): DownloadFormat[] {
  return MARKDOWN_EXTENSION.test(name) ? ['file', 'pdf'] : ['file'];
}

/** `docs/Plan.md` → `Plan.pdf`. Characters a file name cannot hold become `-`. */
export function pdfFileName(name: string): string {
  const last = name.split('/').pop() ?? '';
  const base = last.replace(MARKDOWN_EXTENSION, '').replace(/[\\:*?"<>|\u0000-\u001f]/g, '-').trim();
  return `${base || 'document'}.pdf`;
}

/**
 * markdown-it options for the PDF. `html: false` escapes raw HTML in the file,
 * so the document never runs a script or loads a tag the author typed; the
 * default link check already drops `javascript:` links.
 */
export const PRINT_MARKDOWN_OPTIONS = { html: false, linkify: true, typographer: true } as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Paper, not the app theme: black on white in both app themes.
const PRINT_CSS = `
@page { margin: 18mm 16mm; }
html { -webkit-text-size-adjust: 100%; }
body { max-width: 720px; margin: 0 auto; color: #111; font: 11pt/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 1.8em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; } h4, h5, h6 { font-size: 1em; }
body > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table { margin: 0 0 0.9em; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.2em; }
a { color: inherit; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace; font-size: 0.9em; }
code { background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f6f6f6; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; font-size: 1em; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ddd; color: #555; }
table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #f6f6f6; }
tr { break-inside: avoid; page-break-inside: avoid; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1.5em 0; }
`;

/** The printable HTML document for a markdown file. `md` is a markdown-it built with `PRINT_MARKDOWN_OPTIONS`. */
export function markdownPrintHtml(
  markdown: string,
  title: string,
  md: { render(source: string): string }
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${md.render(markdown)}</body></html>`;
}
