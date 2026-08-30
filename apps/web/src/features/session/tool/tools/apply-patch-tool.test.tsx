import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApplyPatchTool } from './apply-patch-tool';

const part = (files: unknown[], status = 'completed', output = 'ok'): ToolPart =>
  ({
    id: '1',
    type: 'tool',
    tool: 'apply_patch',
    callID: 'c1',
    state: { status, output, metadata: { files }, time: { start: 1, end: 2 } },
  }) as unknown as ToolPart;

const render = (p: ToolPart, open = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ApplyPatchTool part={p} defaultOpen={open} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

/** The trigger's visible words, with markup and icons stripped. */
const rowText = (markup: string) =>
  markup
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ADDS = [
  { relativePath: 'random-aurora.txt', type: 'add', additions: 1 },
  { relativePath: 'random-cactus.txt', type: 'add', additions: 1 },
  { relativePath: 'random-orbit.txt', type: 'add', additions: 1 },
  { relativePath: 'random-pixel.txt', type: 'add', additions: 1 },
];

describe('ApplyPatchTool trigger', () => {
  test('says what happened, not which mechanism did it', () => {
    // The regression this replaced: "Apply Patch 4 files · +4" under a
    // code-file glyph, over four plain .txt files that had just been created.
    const text = rowText(render(part(ADDS)));
    expect(text).toContain('Created 4 files');
    expect(text).not.toContain('Apply Patch');
  });

  test('a closed row still carries a size signal', () => {
    // This guarded the `+N`/`−N` diff stat, which was once silently commented
    // out of the trigger with nothing failing. The stat has since been removed
    // deliberately (`args` dropped from the trigger), so what the row owes the
    // reader is the COUNT — the one thing left that says how big the change is.
    expect(rowText(render(part(ADDS)))).toContain('4 files');
  });

  test('one file names itself', () => {
    expect(rowText(render(part([ADDS[0]])))).toContain('Created random-aurora.txt');
  });

  test('a mixed patch claims no shape it does not have', () => {
    const mixed = [ADDS[0], { relativePath: 'gone.ts', type: 'delete', deletions: 3 }];
    const text = rowText(render(part(mixed)));
    expect(text).toContain('Changed 2 files');
    expect(text).not.toContain('Created');
  });

  test('an edit reads as an edit', () => {
    expect(
      rowText(render(part([{ relativePath: 'a.ts', type: 'update', additions: 2 }]))),
    ).toContain('Edited a.ts');
  });

  test('per-file badges are labels, not shouting', () => {
    // The file list lives behind the row's own caret, so this one renders open.
    const markup = render(part(ADDS), true);
    expect(markup).toContain('Add');
    expect(markup).not.toContain('uppercase');
    expect(markup).toContain('random-aurora.txt');
  });
});

describe('ApplyPatchTool, when the patch did not land', () => {
  // The row already flipped its icon to a warning through `ToolOutcomeContext`,
  // then kept saying "Created 4 files" underneath it — glyph and words
  // disagreeing about one call. `group-steps.ts` forbids exactly this on the
  // panel (W7); the trigger had no such route until now.
  test('a failed patch does not wear the wording of one that succeeded', () => {
    const text = rowText(render(part(ADDS, 'completed', 'Error: patch does not apply')));

    // Entity, not a raw apostrophe: `rowText` strips tags but not escapes, and
    // asserting the raw string would be an assertion that can never fail.
    expect(text).toContain('Couldn&#x27;t create');
    expect(text).not.toContain('Created 4 files');
  });
});
