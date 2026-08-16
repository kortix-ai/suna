import { memoryRelPath } from '@/features/session/tool/shared/memory-helpers';
import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryTool, memoryRowTarget, memoryToolTitle } from './memory-tool';

/**
 * The contract this file pins (spec W8).
 *
 * The memory row used to say "Memory" and nothing else: the subtitle was
 * commented out, so `onSubtitleClick` — the way into the memory file — was
 * wired to an element that never rendered, and one fixed title covered six
 * commands. A reader could not tell a write from a read, and could not see
 * WHICH memory file either one touched.
 *
 * Now the title reports what happened and the subtitle names the target.
 *
 * The subtitle's text and the file the click opens both come from ONE call to
 * `memoryRowTarget`. Resolved separately they immediately disagreed on a
 * rename — the row showed the destination and opened the source, a name the
 * rename had just removed. The click itself cannot be dispatched here (no DOM),
 * so the agreement is asserted on that resolver directly, and the rendered
 * subtitle is checked against the same call's answer.
 *
 * The harness renders to static markup (this app has no DOM in tests), so the
 * assertions are anchored to the trigger's own elements: the title is the
 * trigger's leading span, the subtitle is the span carrying the same text in a
 * native `title` attribute. A bare `toContain('Memory updated')` would pass on
 * a row whose title had moved into the body.
 *
 * Rows are rendered COLLAPSED, so nothing from the tool body can satisfy a
 * trigger assertion by accident.
 */

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ hardcodedUi: {} }} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function memoryPart(input: Record<string, unknown>, output = ''): ToolPart {
  return {
    id: 'p1',
    type: 'tool',
    tool: 'memory',
    callID: 'call-1',
    state: { status: 'completed', input, output, metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as ToolPart;
}

const render = (part: ToolPart) => renderToStaticMarkup(withProviders(<MemoryTool part={part} />));

describe('memoryToolTitle', () => {
  test('every command that CHANGES memory reads as an update', () => {
    for (const command of ['create', 'insert', 'str_replace', 'rename', 'delete']) {
      expect(memoryToolTitle(command)).toBe('Memory updated');
    }
  });

  test('view is the one read', () => {
    expect(memoryToolTitle('view')).toBe('Memory read');
  });

  test('an unknown or not-yet-streamed command falls back to the bare noun', () => {
    // A half-streamed call has no `command` yet. Guessing a verb here would
    // announce a write that may turn out to be a read.
    expect(memoryToolTitle('')).toBe('Memory');
    expect(memoryToolTitle('some_future_command')).toBe('Memory');
  });
});

describe('memoryRowTarget — the row opens the file it names', () => {
  const DRAFT = '.kortix/memory/draft.md';
  const FINAL = '.kortix/memory/notes/final.md';

  test('a rename names AND opens its destination', () => {
    const { openPath, subtitle } = memoryRowTarget('rename', DRAFT, FINAL);

    expect(subtitle).toBe('notes/final.md');
    expect(openPath).toBe(FINAL);
    // The agreement itself, in one assertion. This is the defect that shipped
    // for a commit: the row displayed `notes/final.md` and opened `draft.md` —
    // the name the rename had just removed — so the click landed on a file that
    // no longer existed.
    expect(memoryRelPath(openPath)).toBe(subtitle);
  });

  test('a rename with no destination in its input falls back to the source, for BOTH', () => {
    // `new_path` can be missing on a half-streamed or malformed call. The source
    // is then the only name the row can truthfully give, and the label and the
    // click must still give the same one.
    const { openPath, subtitle } = memoryRowTarget('rename', DRAFT, '');

    expect(openPath).toBe(DRAFT);
    expect(memoryRelPath(openPath)).toBe(subtitle);
  });

  test('every other command targets its own path', () => {
    for (const command of ['view', 'create', 'insert', 'str_replace', 'delete']) {
      const { openPath, subtitle } = memoryRowTarget(command, FINAL, '');
      expect(openPath).toBe(FINAL);
      expect(memoryRelPath(openPath)).toBe(subtitle);
    }
  });

  test('the memory root and an empty path earn no subtitle, and stay in step', () => {
    // `memoryRelPath` answers 'memory' for the root, which as a subtitle only
    // repeats the title's noun. The row still knows what it would open.
    const root = memoryRowTarget('view', '.kortix/memory', '');
    expect(root.openPath).toBe('.kortix/memory');
    expect(root.subtitle).toBeUndefined();

    const nothing = memoryRowTarget('', '', '');
    expect(nothing.openPath).toBe('');
    expect(nothing.subtitle).toBeUndefined();
  });
});

describe('MemoryTool — the trigger says what happened, and to what', () => {
  test('a write titles itself an update and names the file it wrote', () => {
    const markup = render(
      memoryPart({ command: 'str_replace', path: '.kortix/memory/notes/deploy.md' }),
    );

    expect(markup).toContain('>Memory updated</span>');
    // The subtitle element, not the string anywhere: it carries the same text
    // as its native tooltip because the row truncates.
    expect(markup).toContain('title="notes/deploy.md">notes/deploy.md</span>');
  });

  test('a read titles itself a read', () => {
    const markup = render(memoryPart({ command: 'view', path: '.kortix/memory/notes/deploy.md' }));

    expect(markup).toContain('>Memory read</span>');
    expect(markup).not.toContain('>Memory updated</span>');
    expect(markup).toContain('title="notes/deploy.md">notes/deploy.md</span>');
  });

  test('a rename is named by its DESTINATION, not by the name that is gone', () => {
    const markup = render(
      memoryPart({
        command: 'rename',
        old_path: '.kortix/memory/draft.md',
        new_path: '.kortix/memory/notes/final.md',
      }),
    );

    expect(markup).toContain('>Memory updated</span>');
    // Rendered from the SAME resolution the click uses, so the row cannot show
    // one file and open another.
    const { subtitle } = memoryRowTarget(
      'rename',
      '.kortix/memory/draft.md',
      '.kortix/memory/notes/final.md',
    );
    expect(subtitle).toBe('notes/final.md');
    expect(markup).toContain(`title="${subtitle}">${subtitle}</span>`);
    expect(markup).not.toContain('title="draft.md"');
  });

  test('a completed rename carrying no new_path is labelled by its source', () => {
    // Not a claim about streaming — this is a settled part whose input simply
    // has no destination. An empty subtitle would drop the one thing the row can
    // still truthfully say, and `memoryRowTarget` above pins that the click
    // falls back to the same file.
    const markup = render(memoryPart({ command: 'rename', old_path: '.kortix/memory/draft.md' }));

    expect(markup).toContain('title="draft.md">draft.md</span>');
  });

  test('viewing the memory root shows no subtitle — it would only repeat the title', () => {
    // `memoryRelPath` answers 'memory' for the root itself, which as a subtitle
    // reads "Memory read · memory".
    const markup = render(
      memoryPart(
        { command: 'view', path: '.kortix/memory' },
        'files and directories in .kortix/memory:\n120\t.kortix/memory/notes.md',
      ),
    );

    expect(markup).toContain('>Memory read</span>');
    expect(markup).not.toContain('>memory</span>');
  });

  test('a call with no command and no path is still a titled row, never blank', () => {
    const markup = render(memoryPart({}));

    expect(markup).toContain('>Memory</span>');
  });

  test('the row is collapsed — none of the above came from the body', () => {
    const markup = render(
      memoryPart({ command: 'create', path: '.kortix/memory/notes.md', file_text: 'remember me' }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('remember me');
  });
});
