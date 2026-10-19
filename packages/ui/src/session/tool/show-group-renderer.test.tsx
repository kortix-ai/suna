import './tools/register';
import { TooltipProvider } from '../../components/ui/tooltip';
import { NextIntlClientProvider } from '../../i18n';
import type { ToolPart } from '../../shared/ui';
import { sessionLogShowGroupCall, toolCallBlock } from '@kortix/sdk';
import { AppWindowIcon, GlobeIcon } from '@phosphor-icons/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ShowGroupRenderer } from './show-group-renderer';
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
const TAB = /role="tab"/g;
const SELECTED_TAB = /role="tab" aria-selected="true"[^>]*title="([^"]*)"/;

describe('ShowGroupRenderer', () => {
  test('two consecutive show calls render as ONE card with one header tab per call', () => {
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer calls={[toolCallBlock(EDITOR), toolCallBlock(DOCS)]} />));

    expect(html.match(CARD)).toHaveLength(1);
    expect(html.match(TAB)).toHaveLength(2);
    expect(html.match(SELECTED_TAB)?.[1]).toBe('Editor');
    // The tabs are the navigation: no footer chevron strip inline.
    expect(html).not.toContain('border-t px-2 py-1.5');
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
      withProviders(<ShowGroupRenderer calls={[toolCallBlock(EDITOR), toolCallBlock(DOCS)]} />),
    );
    const single = renderToStaticMarkup(withProviders(<ToolPartRenderer call={toolCallBlock(multi)} />));

    expect(grouped).toBe(single);
  });

  test('a later call still streaming holds a pending slot in the same card', () => {
    const running = showPart('3', undefined, 'running');
    const html = renderToStaticMarkup(
      withProviders(<ShowGroupRenderer calls={[toolCallBlock(EDITOR), toolCallBlock(running)]} />),
    );

    expect(html.match(CARD)).toHaveLength(1);
    expect(html.match(TAB)).toHaveLength(2);
    expect(html).toContain('Editor body.');
  });
});

describe('ShowGroupRenderer file viewers', () => {
  const TXT_A = showPart('a', { type: 'file', path: '/workspace/q1.txt' });
  const TXT_B = showPart('b', { type: 'file', path: '/workspace/q2.txt' });
  // `ViewerFrame`'s header row: the file name, plus actions on the panel.
  const FILE_NAME_ROW = /min-h-12[^>]*><span[^>]*>q1\.txt</;

  test('the header tab names the file, so the viewer draws no second name row', () => {
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer calls={[toolCallBlock(TXT_A), toolCallBlock(TXT_B)]} />));

    expect(html.match(TAB)).toHaveLength(2);
    expect(html).not.toMatch(FILE_NAME_ROW);
  });

  test('every file tab is a hover-card trigger', () => {
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer calls={[toolCallBlock(TXT_A), toolCallBlock(TXT_B)]} />));

    expect(html.match(/role="tab"[^>]*data-slot="hover-card-trigger"/g)).toHaveLength(2);
  });

  test('a single file show draws no name row; its header is the hover-card trigger', () => {
    const html = renderToStaticMarkup(withProviders(<ToolPartRenderer call={toolCallBlock(TXT_A)} />));

    expect(html).not.toMatch(FILE_NAME_ROW);
    expect(html).not.toContain('>q1.txt<');
    expect(html).toContain('data-slot="hover-card-trigger"');
  });
});

describe('ShowGroupRenderer port tabs', () => {
  test('a running localhost port is marked with the app-window icon', () => {
    const port = showPart('p', { type: 'url', url: 'http://localhost:3000/' });
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer calls={[toolCallBlock(EDITOR), toolCallBlock(port)]} />));
    const appWindow = renderToStaticMarkup(<AppWindowIcon className="size-3.5 shrink-0" />);
    const globe = renderToStaticMarkup(<GlobeIcon className="size-3.5 shrink-0" />);

    const portTab = html.slice(html.lastIndexOf('role="tab"'));
    expect(portTab).toContain(appWindow);
    expect(portTab).not.toContain(globe);
  });

  test('an active port slide fills the 420px slot, leaving no gap under the frame', () => {
    const port = showPart('p', { type: 'url', url: 'http://localhost:3000/' });
    const html = renderToStaticMarkup(withProviders(<ShowGroupRenderer calls={[toolCallBlock(port), toolCallBlock(EDITOR)]} />));

    expect(html).toContain('bg-secondary relative w-full overflow-hidden h-[420px]');
    expect(html).not.toContain('aspect-video');
  });
});

describe('sessionLogShowGroupCall (the merge the card renders)', () => {
  test('keeps the first call identity so the card does not re-mount', () => {
    const merged = sessionLogShowGroupCall([EDITOR, DOCS].map(toolCallBlock));

    expect(merged.id).toBe('1');
    expect(merged.call_id).toBe('call_1');
    expect(merged.status).toBe('complete');
  });

  test('is running while any call in the group is still running', () => {
    const merged = sessionLogShowGroupCall([EDITOR, showPart('3', undefined, 'running')].map(toolCallBlock));

    expect(merged.status).toBe('running');
    const items = (merged.input as { items: { status?: string }[] }).items;
    expect(items.map((i) => i.status)).toEqual(['ready', 'pending']);
  });

  test('a failed call keeps its slot as an error item with the message', () => {
    const failed = showPart('4', { type: 'image', title: 'Docs' }, 'error', {
      error: 'File not found: /workspace/docs.png',
    });
    const items = (sessionLogShowGroupCall([EDITOR, failed].map(toolCallBlock)).input as {
      items: Record<string, unknown>[];
    }).items;

    expect(items[1]).toEqual({
      status: 'error',
      type: 'error',
      title: 'Docs',
      content: 'File not found: /workspace/docs.png',
    });
  });
});
