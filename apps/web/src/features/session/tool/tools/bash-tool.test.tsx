import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolSurfaceContext } from '@/features/session/tool/shared/surface';
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

// The command card's geometry, asserted on the emitted class attributes.
//
// Every one of these was broken at once, and all four were invisible to the
// existing tests because they only checked that text reached the DOM: the
// command sat at `px-0` against the card border while its own output sat at
// 12px, the copy button was a flex sibling centred on the vertical middle of a
// three-line command, `pr-9` reserved space for a control that ALSO took real
// width, and `SHIKI_RESET`'s `text-sm` on the <code> beat the <pre>'s inherited
// `text-xs`, drawing the command at 14px over 12px output.
//
// Class strings are the contract here because they are the whole bug — there
// is no behavior to assert, only geometry. Arbitrary variants arrive
// HTML-escaped (`[&_code]` → `[&amp;_code]`), so match a substring that skips
// the ampersand.
describe('BashTool command card geometry', () => {
  const html = renderToStaticMarkup(
    withProviders(<BashTool part={makePart('echo hi', 'hi')} defaultOpen />),
  );

  test('command and output share one left edge', () => {
    expect(html).toContain('p-3 pr-11');
    expect(html).not.toContain('px-0');
  });

  test('the copy button floats instead of sitting in a flex row', () => {
    expect(html).toContain('absolute top-2 right-2');
    expect(html).not.toContain('justify-between');
    expect(html).not.toContain('pr-9');
  });

  test('the highlighted command inherits the 12px type size', () => {
    expect(html).toContain('_code]:text-xs');
  });
});

// The 22px indent lines a card up with the trigger row's TEXT column, which
// exists only on the inline surface — the panel has no icon gutter and brings
// its own `p-4`, so the same indent just pushed the card off its header.
describe('BashTool indent is surface-aware', () => {
  const part = makePart('echo hi', 'hi');

  test('inline keeps the icon-gutter indent', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={part} defaultOpen />));

    expect(html).toContain('ml-5.5');
  });

  test('the panel drops it', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <BashTool part={part} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain('ml-5.5');
  });
});
