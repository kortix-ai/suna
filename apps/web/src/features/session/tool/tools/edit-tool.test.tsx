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
): ToolPart {
  return {
    type: 'tool',
    tool: 'edit',
    callID: 'call-1',
    state: status === 'completed' ? { status, input, output: 'ok', metadata: {} } : { status, input },
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
