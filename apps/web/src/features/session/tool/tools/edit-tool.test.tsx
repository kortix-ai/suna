import { ToolRunningContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EditTool } from './edit-tool';

function withProviders(node: ReactNode) {
  const queryClient = new QueryClient();
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function makePart(
  input: Record<string, unknown>,
  status: 'completed' | 'running' = 'completed',
  output = 'ok',
): ToolPart {
  return {
    type: 'tool',
    tool: 'edit',
    callID: 'call-1',
    state: status === 'completed' ? { status, input, output, metadata: {} } : { status, input },
  } as unknown as ToolPart;
}

// The row's `+N −N`, diffed from the same before/after the expanded DiffView
// renders. DiffStat prints a true minus sign (U+2212), so these assertions
// would not pass on an ASCII-hyphen regression — pinned on purpose: the DS
// glyph is the contract.
describe('EditTool trigger carries the line counts', () => {
  test('a settled edit reports +added −removed without being expanded', () => {
    // 'b' replaced by 'x\ny': one line out, two in.
    const html = renderToStaticMarkup(
      withProviders(
        <EditTool
          part={makePart({
            filePath: '/workspace/app.py',
            oldString: 'a\nb\nc',
            newString: 'a\nx\ny\nc',
          })}
        />,
      ),
    );

    expect(html).toContain('app.py');
    expect(html).toContain('>+2<');
    expect(html).toContain('>−1<');
  });

  test('an all-additions edit carries no dangling −0', () => {
    // Trailing newline on BOTH sides: jsdiff treats `a` and `a\n` as different
    // lines, so an inconsistent pair would count a phantom −1.
    const html = renderToStaticMarkup(
      withProviders(
        <EditTool
          part={makePart({ filePath: '/f.ts', oldString: 'a\n', newString: 'a\nb\nc\n' })}
        />,
      ),
    );

    expect(html).toContain('>+2<');
    expect(html).not.toContain('−0');
  });

  test('an identical before/after draws no stat at all', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <EditTool part={makePart({ filePath: '/f.ts', oldString: 'a\nb', newString: 'a\nb' })} />,
      ),
    );

    expect(html).not.toContain('diff-stat');
  });

  test('a RUNNING edit carries no stat — counting a half-arrived diff per chunk is per-frame work', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value>
          <EditTool
            part={makePart(
              { filePath: '/f.ts', oldString: 'a\nb\nc', newString: 'a\nx\ny\nc' },
              'running',
            )}
          />
        </ToolRunningContext.Provider>,
      ),
    );

    expect(html).not.toContain('diff-stat');
  });
});

describe('EditTool speaks the tense the row is actually in', () => {
  const edit = { filePath: '/workspace/app.py', oldString: 'a', newString: 'b' };

  test('a live call is present tense, beside the filename it is editing', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value>
          <EditTool part={makePart(edit, 'running')} />
        </ToolRunningContext.Provider>,
      ),
    );

    expect(html).toContain('Editing');
    expect(html).toContain('app.py');
  });

  // The regression this whole change exists for: `Editing` was hardcoded, so a
  // call that finished an hour ago still claimed to be mid-flight. A restored
  // transcript is entirely settled calls, every one of them reading as live.
  test('a settled call is PAST tense — it is not still editing', () => {
    const html = renderToStaticMarkup(withProviders(<EditTool part={makePart(edit)} />));

    expect(html).toContain('Edited');
    expect(html).not.toContain('Editing');
  });

  test('a failed edit never claims it edited', () => {
    // Escaped apostrophe: `renderToStaticMarkup` emits the entity, and a raw
    // string here would be an assertion that can never fail.
    const html = renderToStaticMarkup(
      withProviders(<EditTool part={makePart(edit, 'completed', 'Error: ENOENT')} />),
    );

    expect(html).toContain('Couldn&#x27;t update');
    expect(html).not.toContain('>Edited<');
  });
});

describe('EditTool, for the part that never got its diff', () => {
  // `write-tool.tsx` removed this shimmer; `edit` kept it, so one situation had
  // two answers — and on a restored session the animation promised a diff that
  // was never going to arrive, forever.
  const stale = makePart({}, 'running');

  test('a stale pending part states the fact instead of shimmering forever', () => {
    const html = renderToStaticMarkup(withProviders(<EditTool part={stale} defaultOpen />));

    expect(html).toContain('No content received');
    expect(html).not.toContain('Waiting for file content');
  });
});
