import type { Part } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { Disclosure } from '@/components/ui/disclosure';
import { ActivityFileChipStep } from './activity-file-chips';

/** The first path segment of Phosphor's `PencilSimple`, the write family glyph. */
const PENCIL_PATH = 'M227.31,73.37';

const writePart = (filePath: string): Part =>
  ({
    id: 'p1',
    type: 'tool',
    tool: 'write',
    callID: 'c1',
    state: {
      status: 'completed',
      input: { filePath },
      output: 'ok',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as unknown as Part;

const render = (parts: Part[], bare: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <Disclosure open={false} onOpenChange={() => {}}>
          <ActivityFileChipStep parts={parts} running={false} sessionId="s1" bare={bare} />
        </Disclosure>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('every file-chip row keeps its family glyph', () => {
  // `ActivityStep` already documents this rule at length and applies it. Its
  // sibling here still guarded the icon behind `!bare`, so a lone `write`
  // rendered as a bare line of text with no pencil on it — the one mark that
  // says WHICH tool ran, dropped in the case with the least other context to
  // recover it from.
  test('a LONE write row leads with the pencil', () => {
    const html = render([writePart('/workspace/src/main.ts')], true);

    expect(html).toContain(PENCIL_PATH);
  });

  test('a grouped run leads with the same pencil — one rule, both shapes', () => {
    const html = render([writePart('/workspace/a.ts'), writePart('/workspace/b.ts')], false);

    expect(html).toContain(PENCIL_PATH);
  });

  test('the row still names the file it wrote', () => {
    const html = render([writePart('/workspace/src/main.ts')], true);

    expect(html).toContain('Wrote');
    expect(html).toContain('main.ts');
  });
});
