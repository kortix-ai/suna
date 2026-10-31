import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthProvider } from '@/features/providers/auth-provider';
import { BlogMarkdown } from './blog-markdown';

describe('BlogMarkdown live rich renderers', () => {
  it('renders lead inline formatting and every rich fence', () => {
    const markup = renderToStaticMarkup(<AuthProvider><BlogMarkdown lead="A **clear** `lead`" body={[
      '```compare\nthem: Other\nrows:\n  - dimension: Setup\n    them: Manual\n    kortix: Automatic\n```',
      '```verdict\nthemLabel: Alternative\nthem: Separate tools\nkortix: One workflow\n```',
      '```logos\nlabel: Integrations\nitems:\n  - domain: example.test\n    name: Example tool\n```',
      '```cta\ntitle: Try the workflow\nbody: Start here\n```',
    ].join('\n\n')} /></AuthProvider>);
    for (const text of ['<strong', '>clear</strong>', '>lead</code>', 'Setup', 'Manual', 'Automatic', 'Alternative', 'Separate tools', 'One workflow', 'Integrations', 'Example tool', 'Try the workflow', 'Start here']) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain('```');
  });

  it('renders an empty body without a lead', () => {
    expect(renderToStaticMarkup(<BlogMarkdown body="" />)).toBe('<div class="mt-10"></div>');
  });
});
