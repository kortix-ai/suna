import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { BashTool } from './bash-tool';

// Regression guard for `code.slice is not a function`.
//
// `CommandBlock` used to route its RICH output branch through
// `HighlightedCode`: `code={richOutput as unknown as string}`. `richOutput` is
// a React element, not source text, and `shikiKey` calls `.slice` on its
// `code` argument — from inside a `useState` INITIALIZER, so it threw during
// render and the error boundary swallowed the whole tool part. The double cast
// was the only thing letting an element past a prop typed `string`.
//
// `renderToStaticMarkup` reproduces it exactly: useState initializers run
// during a synchronous render, so a throw here is the same throw the browser
// hit. Each of the three rich branches gets its own case — they are three
// independent parsers feeding one shared crash site.

function withProviders(node: ReactNode) {
  const queryClient = new QueryClient();
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function makePart(command: string, output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'bash',
    callID: 'call-1',
    state: { status: 'completed', input: { command }, output, metadata: {} },
  } as unknown as ToolPart;
}

// `hasStructuredContent` fires on a Python traceback.
const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/workspace/main.py", line 3, in <module>',
  '    raise ValueError("boom")',
  'ValueError: boom',
].join('\n');

// `parseSessionMetadataOutput` needs `===` + a JSON blob carrying `id` + `time`.
const SESSION_META = [
  '=== /workspace/.kortix/sessions/ses_abc.json',
  JSON.stringify({
    id: 'ses_abc',
    slug: 'refactor-pricing',
    title: 'Refactor pricing',
    time: { created: 1_700_000_000, updated: 1_700_000_100 },
  }),
].join('\n');

// `parseSessionMessagesOutput` needs at least one `--- Msg N [role] cost=$X ---`.
const SESSION_MESSAGES = [
  '--- Msg 1 [user] cost=$0.0012 ---',
  'Ship the new pricing page',
  '--- Msg 2 [assistant] cost=$0.0340 ---',
  'On it.',
].join('\n');

describe('BashTool renders rich output without pushing elements through Shiki', () => {
  test('a traceback renders the structured-output block instead of throwing', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('python main.py', TRACEBACK)} defaultOpen />),
    );

    // Pre-fix this render threw `code.slice is not a function`.
    expect(html).toContain('ValueError');
    expect(html).toContain('python main.py');
  });

  test('session metadata output renders the session list', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('kortix sessions list', SESSION_META)} defaultOpen />),
    );

    expect(html).toContain('Refactor pricing');
    expect(html).toContain('1 session');
  });

  test('session messages output renders the message list', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('kortix sessions messages', SESSION_MESSAGES)} defaultOpen />,
      ),
    );

    expect(html).toContain('2 messages');
    expect(html).toContain('Ship the new pricing page');
  });

  test('plain output still renders as monospace text, not a rich block', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('echo hi', 'hi')} defaultOpen />),
    );

    expect(html).toContain('echo hi');
    expect(html).toContain('hi');
  });
});
