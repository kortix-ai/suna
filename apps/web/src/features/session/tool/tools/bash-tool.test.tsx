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

// The indent lines a card up with the trigger row's TEXT column, which exists
// only on the inline surface — the panel has no icon gutter and brings its own
// `p-4`, so the same indent just pushed the card off its header.
//
// The value is a variable with a 1.375rem (22px) default rather than a literal
// `ml-5.5`, because a surface that overrides the row's `gap-1.5` moves the text
// column the indent is supposed to match. The chain of thought does exactly
// that (`turn/activity-step.tsx` forces `gap-3`), and a hardcoded 22px left the
// card 6px short of every other row's content. Unset, the default is the same
// 22px this suite has always asserted.
// A shell's verdict, which nothing in the row could report.
//
// `partOutcome` — the predicate the chain uses for its warning mark — looks for
// an `Error:` prefix or the `{success:false}` contract, and a shell returns
// neither: a failing test run prints its failures to stdout exactly as a
// passing one prints its successes, and the heuristic gives up above 500
// characters anyway. So a red build and a green build drew the identical row,
// and the only way to tell them apart was to expand the card and read the log.
//
// The code was in the output the whole time, in the `<exit_code>` tag the bash
// tool appends — which `partOutput` strips before any renderer sees it.
describe('BashTool reports whether the command actually worked', () => {
  test('a failed command says so in words, without being expanded', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('bun test', 'FAIL 3 tests\n<exit_code>1</exit_code>')} />,
      ),
    );

    expect(html).toContain('Command failed');
    expect(html).not.toContain('Ran command');
  });

  test('a successful command keeps the neutral wording', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('ls', 'a.txt\n<exit_code>0</exit_code>')} />),
    );

    expect(html).toContain('Ran command');
    expect(html).not.toContain('Command failed');
  });

  test('an untagged command is not accused of failing', () => {
    // No `<exit_code>` is an ABSENT verdict, not a bad one. Treating a missing
    // tag as 0 would be the same lie in the other direction.
    const html = renderToStaticMarkup(withProviders(<BashTool part={makePart('ls', 'a.txt')} />));

    expect(html).toContain('Ran command');
    expect(html).not.toContain('Command failed');
  });

  test('the exact code appears once, in the expanded card', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('bun test', 'FAIL\n<exit_code>2</exit_code>')} defaultOpen />),
    );

    expect(html).toContain('Exit code 2');
  });

  test('a successful command carries no exit-code line', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('ls', 'a.txt\n<exit_code>0</exit_code>')} defaultOpen />),
    );

    expect(html).not.toContain('Exit code');
  });
});

describe('BashTool card, for the cases with nothing to show', () => {
  test('a multi-line command admits there is more than the line shown', () => {
    // A collapsed row drew line 1 of a 30-line heredoc and said nothing about
    // the other 29, so a whole script looked like a one-liner.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('cat <<EOF\ntwo\nthree\nEOF', 'done')} />),
    );

    expect(html).toContain('+3');
  });

  test('a single-line command carries no line count', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={makePart('ls -la', 'out')} />));

    expect(html).not.toContain('+0');
  });

  test('a settled command that printed nothing says so', () => {
    // The region used to be omitted entirely, leaving a command card with dead
    // space under it — indistinguishable from output we failed to capture.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('mkdir -p build', '')} defaultOpen />),
    );

    expect(html).toContain('No output');
  });

  test('a RUNNING command never claims it produced nothing', () => {
    // Silence mid-flight means "not yet". Saying "No output" would report a
    // result the call has not returned.
    const running = {
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: { status: 'running', input: { command: 'sleep 10' }, metadata: {} },
    } as unknown as ToolPart;
    const html = renderToStaticMarkup(withProviders(<BashTool part={running} defaultOpen />));

    expect(html).not.toContain('No output');
  });

  test('command and output scroll independently', () => {
    // One shared `max-h-96` used to wrap both, so 200 lines of build log pushed
    // the command off the top of its own card — the reader lost the only line
    // saying what they were looking at. Two regions, two caps.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('bun test', 'x\n'.repeat(200))} defaultOpen />),
    );

    expect(html).toContain('max-h-64');
    expect(html).toContain('max-h-80');
    expect(html).not.toContain('max-h-96');
  });

  test('the output gets its own copy button', () => {
    // The command had one; the output — the half a reader wants to paste into
    // an issue — had none.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('ls', 'a.txt')} defaultOpen />),
    );

    expect(html.match(/absolute top-2 right-2/g)?.length).toBe(2);
  });
});

describe('BashTool indent is surface-aware', () => {
  const part = makePart('echo hi', 'hi');
  const INDENT = 'ml-[var(--tool-indent,1.375rem)]';

  test('inline keeps the icon-gutter indent', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={part} defaultOpen />));

    expect(html).toContain(INDENT);
  });

  test('the panel drops it', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <BashTool part={part} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain(INDENT);
    expect(html).not.toContain('--tool-indent');
  });
});
