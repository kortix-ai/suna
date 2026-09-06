import { ToolRunningContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WriteTool, writeStat } from './write-tool';

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
    tool: 'write',
    callID: 'call-1',
    state: status === 'completed' ? { status, input, output, metadata: {} } : { status, input },
  } as unknown as ToolPart;
}

describe('writeStat — the count a closed row reports', () => {
  test('content counts as pure additions — nothing client-side knows the old file', () => {
    expect(writeStat('a\nb\nc')).toEqual({ additions: 3, deletions: 0 });
  });

  test('no content, no stat — the row must not claim an empty write', () => {
    expect(writeStat('')).toBeUndefined();
  });

  test('a trailing newline is a line boundary, same as split() counted it', () => {
    expect(writeStat('a\n')).toEqual({ additions: 2, deletions: 0 });
  });
});

describe('WriteTool trigger carries the filename and the size', () => {
  // `>+3<` pins the DiffStat rendering — the same green `+N` the edit row
  // draws, not the muted args text this used to be.
  test('a settled write shows both, without being expanded', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <WriteTool part={makePart({ filePath: '/workspace/app.py', content: 'a\nb\nc' })} />,
      ),
    );

    expect(html).toContain('app.py');
    expect(html).toContain('>+3<');
    // All additions: a dangling −0 would claim a deletion count we cannot know.
    expect(html).not.toContain('−0');
  });

  test('a STREAMING write already counts — the number climbs with the content', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value>
          <WriteTool
            part={makePart({ filePath: '/workspace/app.py', content: 'a\nb' }, 'running')}
          />
        </ToolRunningContext.Provider>,
      ),
    );

    expect(html).toContain('>+2<');
  });

  test('the expanded row still renders the written content itself', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <WriteTool
          part={makePart({ filePath: '/workspace/note.txt', content: 'hello world' })}
          defaultOpen
        />,
      ),
    );

    expect(html).toContain('hello world');
  });
});

describe('WriteTool speaks the tense the row is actually in', () => {
  // `Write` was the registry key. Every other surface in this feature —
  // step-label.ts, activity-file-chips.tsx, narration.ts — has reported this
  // call as Writing/Wrote for a long time; the trigger was the last holdout,
  // and a machine noun frozen in one tense is what made a settled row read as
  // a paused one.
  test('a live call is present tense, beside the filename it is writing', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value>
          <WriteTool
            part={makePart({ filePath: '/workspace/app.py', content: 'a' }, 'running')}
          />
        </ToolRunningContext.Provider>,
      ),
    );

    expect(html).toContain('Writing');
    expect(html).toContain('app.py');
    expect(html).not.toContain('>Write<');
  });

  test('a settled call is past tense — a finished transcript is all of these', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <WriteTool part={makePart({ filePath: '/workspace/app.py', content: 'a' })} />,
      ),
    );

    expect(html).toContain('Wrote');
    expect(html).not.toContain('Writing');
  });

  // `renderToStaticMarkup` escapes the apostrophe, so the assertion is on the
  // entity. Asserting the raw string here would silently never match and the
  // test would be unable to fail.
  test('a failed write never claims it wrote', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <WriteTool
          part={makePart(
            { filePath: '/workspace/app.py', content: 'a' },
            'completed',
            'Error: EACCES permission denied',
          )}
        />,
      ),
    );

    expect(html).toContain('Couldn&#x27;t write');
    expect(html).not.toContain('>Wrote<');
  });
});

describe('WriteTool, for the part that never got its content', () => {
  // A pending part with no filename and no running turn is a leftover from a
  // finished run — restored sessions carry them. The old body answered with a
  // "Waiting for file content" shimmer that animated forever over content that
  // could never arrive.
  const stale = makePart({}, 'running');

  test('a stale pending part states the fact instead of shimmering forever', () => {
    const html = renderToStaticMarkup(withProviders(<WriteTool part={stale} defaultOpen />));

    expect(html).toContain('No content received');
    expect(html).not.toContain('Waiting for file content');
  });

  test('and it carries no stat — there is nothing to count', () => {
    const html = renderToStaticMarkup(withProviders(<WriteTool part={stale} />));

    expect(html).not.toContain('diff-stat');
  });
});
