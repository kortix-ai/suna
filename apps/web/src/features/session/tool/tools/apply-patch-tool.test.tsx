import { ToolRunningContext } from '@/features/session/tool/shared/infrastructure';
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

const render = (p: ToolPart, open = false, running = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ToolRunningContext.Provider value={running}>
          <ApplyPatchTool part={p} defaultOpen={open} />
        </ToolRunningContext.Provider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

/** A live call whose file list has not arrived yet. */
const streamingPart = (): ToolPart =>
  ({
    id: '1',
    type: 'tool',
    tool: 'apply_patch',
    callID: 'c1',
    state: { status: 'running', metadata: {}, time: { start: 1 } },
  }) as unknown as ToolPart;

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
    // `Wrote`, not `Created` — the row uses the same word a `write` row uses for
    // the same act. See the op table in `patch-summary.ts`.
    expect(text).toContain('Wrote 4 files');
    expect(text).not.toContain('Apply Patch');
    expect(text).not.toContain('Created');
  });

  test('a closed row still carries a size signal', () => {
    // This guarded the `+N`/`−N` diff stat, which was once silently commented
    // out of the trigger with nothing failing. The stat has since been removed
    // deliberately (`args` dropped from the trigger), so what the row owes the
    // reader is the COUNT — the one thing left that says how big the change is.
    expect(rowText(render(part(ADDS)))).toContain('4 files');
  });

  test('one file names itself', () => {
    expect(rowText(render(part([ADDS[0]])))).toContain('Wrote random-aurora.txt');
  });

  test('a mixed patch claims no shape it does not have', () => {
    const mixed = [ADDS[0], { relativePath: 'gone.ts', type: 'delete', deletions: 3 }];
    const text = rowText(render(part(mixed)));
    expect(text).toContain('Changed 2 files');
    expect(text).not.toContain('Wrote');
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
    expect(text).toContain('Couldn&#x27;t write');
    expect(text).not.toContain('Wrote 4 files');
  });
});

describe('ApplyPatchTool while the patch is still streaming', () => {
  // The reported defect: the row opened onto a body holding one shimmering
  // line. Its `px-3` put that line 12px from the row's left edge while every
  // other body under a tool row sits at `--tool-indent` (28px in a chain), so
  // the `ChainOfThought` rail at `left-2` ran 4px off the text — and the line
  // then jumped 16px right the moment the file list replaced it.
  test('the live line is the ROW, not a body under it', () => {
    const markup = render(streamingPart(), false, true);
    expect(markup).toContain('Preparing changes…');
    // On the trigger, inside the header's own flex row.
    expect(markup).toContain('data-component="tool-trigger"');
    // The misaligned body is gone — that inset was its signature.
    expect(markup).not.toContain('px-3 py-2');
  });

  test('a row with nothing to open is not a door', () => {
    // `CollapsibleToolRow`'s rule: no children, no disclosure. Forcing the row
    // open must still produce no trigger affordance and no body, because there
    // is no payload for either to reveal.
    const markup = render(streamingPart(), true, true);
    expect(markup).not.toContain('aria-expanded');
    expect(markup).not.toContain('role="button"');
  });

  test('once files arrive the row names them and opens', () => {
    const live = {
      ...(streamingPart() as unknown as { state: Record<string, unknown> }),
      state: {
        status: 'running',
        metadata: { files: [{ relativePath: 'a/b.ts', type: 'update', additions: 2 }] },
        time: { start: 1 },
      },
    } as unknown as ToolPart;
    const markup = render(live, false, true);
    expect(markup).not.toContain('Preparing changes…');
    expect(rowText(markup)).toContain('Editing b.ts');
    expect(markup).toContain('aria-expanded');
  });
});
