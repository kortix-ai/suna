import { TooltipProvider } from '@/components/ui/tooltip';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mergeShowParts, ShowGroupRenderer } from './show-group-renderer';
import { ToolPartRenderer } from './tool-part-renderer';

// Same providers as show-tool.test.tsx: ShowTool reads translations and
// react-query unconditionally, even on a static render.
function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function showPart(
  id: string,
  input: Record<string, unknown> | undefined,
  status = 'completed',
  extra: Record<string, unknown> = {},
): ToolPart {
  return {
    id,
    type: 'tool',
    tool: 'show',
    callID: `call_${id}`,
    state: { status, ...(input ? { input } : {}), output: '', metadata: {}, ...extra },
  } as unknown as ToolPart;
}

const EDITOR = showPart('1', { type: 'text', title: 'Editor', content: 'Editor body.' });
const DOCS = showPart('2', { type: 'text', title: 'Docs page', content: 'Docs body.' });

const CARD = /data-component="tool-trigger"/g;
const POSITION = (current: number, total: number) =>
  new RegExp(`>${current}<span[^>]*>/</span>${total}<`);

describe('ShowGroupRenderer', () => {
  test('two consecutive show calls render as ONE card at position 1 / 2', () => {
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer parts={[EDITOR, DOCS]} />));

    expect(html.match(CARD)).toHaveLength(1);
    expect(html).toMatch(POSITION(1, 2));
    // The header names the active item, not a generic "2 items".
    expect(html).toContain('title="Editor"');
    expect(html).toContain('Editor body.');
    expect(html).not.toContain('Docs body.');
  });

  test('N single calls and one N-item call render the same card', () => {
    const multi = showPart('m', {
      items: JSON.stringify([
        { type: 'text', title: 'Editor', content: 'Editor body.' },
        { type: 'text', title: 'Docs page', content: 'Docs body.' },
      ]),
    });
    const grouped = renderToStaticMarkup(
      withProviders(<ShowGroupRenderer parts={[EDITOR, DOCS]} />),
    );
    const single = renderToStaticMarkup(withProviders(<ToolPartRenderer part={multi} />));

    expect(grouped).toBe(single);
  });

  test('a later call still streaming holds a pending slot in the same card', () => {
    const running = showPart('3', undefined, 'running');
    const html = renderToStaticMarkup(
      withProviders(<ShowGroupRenderer parts={[EDITOR, running]} />),
    );

    expect(html.match(CARD)).toHaveLength(1);
    expect(html).toMatch(POSITION(1, 2));
    expect(html).toContain('Editor body.');
  });
});

describe('mergeShowParts', () => {
  test('keeps the first call identity so the card does not re-mount', () => {
    const merged = mergeShowParts([EDITOR, DOCS]);

    expect(merged.id).toBe('1');
    expect(merged.callID).toBe('call_1');
    expect(merged.state.status).toBe('completed');
  });

  test('is running while any call in the group is still running', () => {
    const merged = mergeShowParts([EDITOR, showPart('3', undefined, 'running')]);

    expect(merged.state.status).toBe('running');
    const items = (merged.state.input as { items: { status?: string }[] }).items;
    expect(items.map((i) => i.status)).toEqual(['ready', 'pending']);
  });

  test('a failed call keeps its slot as an error item with the message', () => {
    const failed = showPart('4', { type: 'image', title: 'Docs' }, 'error', {
      error: 'File not found: /workspace/docs.png',
    });
    const items = (
      mergeShowParts([EDITOR, failed]).state.input as {
        items: Record<string, unknown>[];
      }
    ).items;

    expect(items[1]).toEqual({
      status: 'error',
      type: 'error',
      title: 'Docs',
      content: 'File not found: /workspace/docs.png',
    });
  });
});
