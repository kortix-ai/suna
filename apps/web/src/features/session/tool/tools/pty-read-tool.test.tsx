import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { PtyReadTool, splitTerminalBuffer } from './pty-read-tool';

// Task 20: a terminal read used to render its whole buffer. Inline the card
// capped it at `max-h-96`; in the Easy panel that cap is removed by design
// (`detail-view.tsx` un-caps every `data-scrollable`), so a 300-line buffer was
// 300 lines of pane. A terminal reads bottom-up, so the tail stays and the
// scrollback folds.

const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line2624JsxTextTerminalOutput: 'Terminal Output',
    },
  },
};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function makePart(output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'pty_read',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { id: 'pty-1' },
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

/** 40 numbered lines: 16 of scrollback, then the 24-line visible tail. */
const LONG_BUFFER = `<pty_output id="pty-1" status="running">
${Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n')}
(End of buffer)
</pty_output>`;

const SHORT_BUFFER = `<pty_output id="pty-1" status="exited">
$ pnpm build
Build succeeded.
(End of buffer)
</pty_output>`;

describe('PtyReadTool folds the scrollback, keeps the tail', () => {
  test('the last 24 lines stay on screen and the rest folds behind a counted trigger', () => {
    const html = renderToStaticMarkup(
      withProviders(<PtyReadTool part={makePart(LONG_BUFFER)} defaultOpen />),
    );

    // Tail: the newest output, which is the answer.
    expect(html).toContain('line-40');
    expect(html).toContain('line-17');

    // Scrollback: named and counted, not rendered.
    expect(html).toContain('16 earlier lines');
    expect(html).toContain('aria-expanded="false"');
    // `line-16` is the last folded line and no visible line contains it as a
    // substring (the tail is line-17…line-40), so this pins the split exactly.
    expect(html).not.toContain('line-16');

    // The buffer marker the runtime appends is a fact about the read, so it
    // stays with the tail.
    expect(html).toContain('End of buffer');
  });

  test('a short buffer is not folded at all — there is nothing to hide', () => {
    const html = renderToStaticMarkup(
      withProviders(<PtyReadTool part={makePart(SHORT_BUFFER)} defaultOpen />),
    );

    expect(html).toContain('pnpm build');
    expect(html).toContain('Build succeeded.');
    expect(html).not.toContain('earlier lines');
  });

  test('panel surface: the same fold, so the pane never takes the whole buffer', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <PtyReadTool part={makePart(LONG_BUFFER)} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('line-40');
    expect(html).toContain('16 earlier lines');
    expect(html).not.toContain('line-16');
  });
});

describe('splitTerminalBuffer', () => {
  test('a buffer at or under the visible height is not split', () => {
    const content = Array.from({ length: 24 }, (_, i) => `line-${i + 1}`).join('\n');
    expect(splitTerminalBuffer(content)).toEqual({ earlier: '', tail: content, earlierCount: 0 });
  });

  test('one line over, and exactly that line folds', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join('\n');
    const split = splitTerminalBuffer(content);
    expect(split.earlierCount).toBe(1);
    expect(split.earlier).toBe('line-1');
    expect(split.tail.split('\n')).toHaveLength(24);
    expect(split.tail.endsWith('line-25')).toBe(true);
  });

  test('an empty buffer folds nothing', () => {
    expect(splitTerminalBuffer('')).toEqual({ earlier: '', tail: '', earlierCount: 0 });
  });
});
