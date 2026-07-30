import { describe, expect, test } from 'bun:test';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRich } from './file-preview';
import { FileViewer, isHtml, isMarkdown, isSvg, languageFor } from './file-viewer';

const SHARE_CONTEXT = { projectId: 'p1', sessionId: 's1' };

function Wrapped({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function render(fileName: string, content = 'x'): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <FileViewer content={content} fileName={fileName} path={`/workspace/${fileName}`} />
    </TooltipProvider>,
  );
}

function renderShareable(fileName: string, content = 'x'): string {
  return renderToStaticMarkup(
    <Wrapped>
      <FileViewer
        content={content}
        fileName={fileName}
        path={`/workspace/${fileName}`}
        shareContext={SHARE_CONTEXT}
      />
    </Wrapped>,
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
    // purpose (it can carry <script> and a top-level tab has no sandbox
    // attribute), and routing SVG through the text path must not re-grant it.
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).not.toContain('aria-label="Open in a new tab"');
  });
});

describe('FileViewer share control', () => {
  test('a text file with share context gets the share button', () => {
    const md = renderShareable('notes.txt', 'hi');
    expect(md).toContain('title="Copy public link"');
  });

  test('the share button is absent without share context, not disabled', () => {
    expect(render('notes.txt', 'hi')).not.toContain('title="Copy public link"');
  });

  test('share context alone is not enough — a file with no path cannot be shared', () => {
    const noPath = renderToStaticMarkup(
      <Wrapped>
        <FileViewer content="hi" fileName="notes.txt" shareContext={SHARE_CONTEXT} />
      </Wrapped>,
    );
    expect(noPath).not.toContain('title="Copy public link"');
  });

  test('the share control sits with the other toolbar actions, not alone', () => {
    // The regression this locks: PreviewShell rendered ShareFileButton and
    // FileViewer did not, so every markdown and text output lost its public
    // link while rich files kept theirs. The two toolbars are contractually
    // identical — see the header of viewer-actions.tsx.
    const md = renderShareable('notes.txt', 'hi');
    expect(md).toContain('title="Copy public link"');
    expect(md).toContain('aria-label="Full screen"');
  });
});
