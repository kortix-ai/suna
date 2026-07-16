import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutputBlock, ToolField, ToolSection } from './output-block';

describe('OutputBlock', () => {
  test('renders mono, capped, token-styled output — never a bare pre', () => {
    const html = renderToStaticMarkup(<OutputBlock text="hello world" />);
    expect(html).toContain('hello world');
    expect(html).toContain('max-h-96');
    expect(html).toContain('data-scrollable');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('bg-muted/20');
  });
});

describe('ToolSection + ToolField', () => {
  test('one sanctioned label treatment; key→value rows', () => {
    const html = renderToStaticMarkup(
      <ToolSection label="Prompt">
        <ToolField label="Schedule" value="every 5m" mono />
      </ToolSection>,
    );
    expect(html).toContain('uppercase');
    expect(html).toContain('tracking-wider');
    expect(html).toContain('Prompt');
    expect(html).toContain('every 5m');
    expect(html).toContain('font-mono');
  });
});
