import { describe, expect, test } from 'bun:test';
import {
  MARKDOWN_PDF_MAX_CHARS,
  markdownPdfBlocker,
  pdfDocumentTitle,
  renderMarkdownForPrint,
} from './markdown-pdf';

describe('pdfDocumentTitle — the saved PDF is named <basename>.pdf', () => {
  test('drops the markdown extension so the browser saves notes.pdf, not notes.md.pdf', () => {
    expect(pdfDocumentTitle('notes.md')).toBe('notes');
    expect(pdfDocumentTitle('guide.mdx')).toBe('guide');
  });

  test('takes the last path segment and only the last extension', () => {
    expect(pdfDocumentTitle('/workspace/docs/report.final.md')).toBe('report.final');
  });

  test('keeps a name that has no extension, and never returns an empty title', () => {
    expect(pdfDocumentTitle('README')).toBe('README');
    expect(pdfDocumentTitle('')).toBe('document');
    expect(pdfDocumentTitle('/workspace/')).toBe('document');
  });
});

describe('markdownPdfBlocker', () => {
  test('an empty, blank, or not-yet-loaded file has nothing to print', () => {
    expect(markdownPdfBlocker(undefined)).toBe('empty');
    expect(markdownPdfBlocker('')).toBe('empty');
    expect(markdownPdfBlocker('  \n\t\n')).toBe('empty');
  });

  test('content up to the ceiling exports; one character past it does not', () => {
    expect(markdownPdfBlocker('# Title')).toBeNull();
    expect(markdownPdfBlocker('x'.repeat(MARKDOWN_PDF_MAX_CHARS))).toBeNull();
    expect(markdownPdfBlocker('x'.repeat(MARKDOWN_PDF_MAX_CHARS + 1))).toBe('too-large');
  });
});

describe('renderMarkdownForPrint — the PDF is the rendered document, not the raw text', () => {
  test('headings, emphasis, inline code and links render as elements', async () => {
    const html = await renderMarkdownForPrint(
      '# Title\n\n## Section\n\nSome **bold** and [a link](https://example.com/page) and `code`.',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toMatch(/<a href="https:\/\/example\.com\/page"[^>]*>a link<\/a>/);
    expect(html).not.toContain('**');
    expect(html).not.toContain('# Title');
  });

  test('lists, GFM task lists and GFM tables render', async () => {
    const html = await renderMarkdownForPrint(
      '- one\n- two\n\n1. first\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
    expect(html).toContain('<ul>\n<li>one</li>');
    expect(html).toContain('<ol>\n<li>first</li>');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain('<input type="checkbox" checked disabled> done');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>2</td>');
  });

  test('a fenced code block keeps its text verbatim inside pre', async () => {
    const html = await renderMarkdownForPrint('```ts\nconst a = 1 < 2;\n```\n');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &#x3C; 2;\n</code></pre>');
  });

  test('math renders to MathML, which prints without KaTeX stylesheets', async () => {
    const html = await renderMarkdownForPrint('Energy: $E = mc^2$');
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML">');
    expect(html).toContain('<msup><mi>c</mi><mn>2</mn></msup>');
  });

  test('embedded HTML never becomes live markup — same rule as the document preview', async () => {
    const html = await renderMarkdownForPrint(
      'Before\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\nAfter',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<p>Before</p>');
    expect(html).toContain('<p>After</p>');
  });

  test('frontmatter prints as an escaped key/value table, not as a rule and a heading', async () => {
    const html = await renderMarkdownForPrint(
      '---\nname: Plan <b>\npermission:\n  edit: allow\n---\n# Body\n',
    );
    expect(html.startsWith('<table data-print-frontmatter="">')).toBe(true);
    expect(html).toContain('<tr><th>name</th><td>Plan &lt;b&gt;</td></tr>');
    expect(html).toContain('<tr><th>permission</th><td>edit: allow</td></tr>');
    expect(html).toContain('<h1>Body</h1>');
    expect(html).not.toContain('<hr>');
  });

  test('images go through the same resolver the preview uses, and are kept when it declines', async () => {
    const html = await renderMarkdownForPrint(
      '![chart](http://localhost:3000/chart.png)\n\n![logo](https://example.com/logo.png)',
      {
        resolveImageSrc: (src) =>
          src.startsWith('http://localhost:3000/') ? '/v1/p/sandbox/3000/chart.png' : undefined,
      },
    );
    expect(html).toContain('<img src="/v1/p/sandbox/3000/chart.png" alt="chart">');
    expect(html).toContain('<img src="https://example.com/logo.png" alt="logo">');
  });
});
