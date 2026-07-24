import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRich } from './file-preview';
import { FileViewer, isHtml, isMarkdown, isSvg, languageFor } from './file-viewer';

function render(fileName: string, content = 'x'): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <FileViewer content={content} fileName={fileName} />
    </TooltipProvider>,
  );
}

describe('file kind predicates', () => {
  test('svg is recognised, and is not confused with the other rendered kind', () => {
    expect(isSvg('logo.svg')).toBe(true);
    expect(isSvg('LOGO.SVG')).toBe(true);
    expect(isSvg('chart.svg.bak')).toBe(false);
    expect(isSvg('page.html')).toBe(false);
    expect(isHtml('logo.svg')).toBe(false);
    expect(isMarkdown('logo.svg')).toBe(false);
  });

  test('svg highlights as xml — shiki has no svg grammar of its own', () => {
    expect(languageFor('logo.svg')).toBe('xml');
    expect(languageFor('page.html')).toBe('html');
    expect(languageFor('notes.txt')).toBe('text');
  });
});

describe('FilePreview routing', () => {
  test('svg leaves the rich path so its source text is fetched', () => {
    // The whole feature depends on this: on the rich path `FileContentRenderer`
    // only ever knows a URL, so the markup never reaches a component that could
    // show it.
    expect(isRich('logo.svg')).toBe(false);
    // Every other image stays rich — nothing else gained a source view.
    expect(isRich('photo.png')).toBe(true);
    expect(isRich('scan.jpeg')).toBe(true);
    expect(isRich('report.pdf')).toBe(true);
    // And the text path is unchanged.
    expect(isRich('page.html')).toBe(false);
    expect(isRich('notes.md')).toBe(false);
  });
});

describe('FileViewer toolbar', () => {
  test('svg earns the Preview/Source toggle, exactly as html does', () => {
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).toContain('aria-label="Preview"');
    expect(svg).toContain('aria-label="Source"');

    const html = render('page.html', '<p>hi</p>');
    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('aria-label="Source"');
  });

  test('a file with only one form gets no toggle — it would have one position', () => {
    // Markdown is the other no-toggle kind, but `DocMarkdown` can't be rendered
    // by this effect-free harness, so plain source stands in for both.
    const txt = render('notes.txt', 'hi');
    expect(txt).not.toContain('aria-label="Preview"');
    expect(isMarkdown('notes.md')).toBe(true);
  });

  test('svg keeps the shared actions in their usual place', () => {
    // "Open in a new tab" stays absent: `isBrowserViewable` excludes SVG on
    // purpose (a same-origin blob URL would execute any embedded <script>), and
    // routing SVG through the text path must not quietly re-grant it.
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).not.toContain('aria-label="Open in a new tab"');
  });
});
