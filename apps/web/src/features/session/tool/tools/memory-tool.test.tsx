import { memoryRelPath } from '@/features/session/tool/shared/memory-helpers';
import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isMemoryMarkdown, MemoryTool, memoryRowTarget, memoryToolTitle } from './memory-tool';

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

const render = (part: ToolPart, open = false) =>
  renderToStaticMarkup(withProviders(<MemoryTool part={part} defaultOpen={open} />));

/** A `view`'s raw output, in the runtime's own "content of X with line
 *  numbers" shape — `parseMemoryView` strips the `N\t` prefix off each line. */
function viewOutput(path: string, lines: string[]): string {
  return [
    `Content of ${path} with line numbers:`,
    ...lines.map((line, i) => `${i + 1}\t${line}`),
  ].join('\n');
}

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

/**
 * The contract this block pins (Task 18, spec W11/D15).
 *
 * A `.md`/`.mdx` memory file used to run through `ToolCodeCard` like every
 * other extension — highlighted, monospaced SOURCE. A note written as
 * `# Deploy notes` came out reading exactly that, `#` and all, instead of a
 * heading. `.json` and everything else is source and stays source.
 *
 * `isMemoryMarkdown` is the one decision this split hangs on, so it is pinned
 * directly (below) AND through both bodies that consult it (`view`'s file
 * branch, `create`) — a mutation that flips either arm of that `if` fails one
 * of the two body tests in each pair: force it always `true` and the `.json`
 * case starts rendering `<h1>`-free source through a document pane (asserted
 * absent below); force it always `false` and the `.md` case stops producing a
 * heading element and starts leaking the literal `#`.
 *
 * Assertions are element-anchored, not bare substrings: a rendered `<h1>`'s
 * captured text, never a `toContain` on the phrase alone — a heading and its
 * un-parsed source can both contain the same words.
 */
describe('isMemoryMarkdown — the render branch, pinned directly', () => {
  test('md and mdx read as documents', () => {
    expect(isMemoryMarkdown('md')).toBe(true);
    expect(isMemoryMarkdown('mdx')).toBe(true);
  });

  test('every other extension keeps the code card', () => {
    for (const ext of ['json', 'txt', 'yaml', 'yml', 'ts', '']) {
      expect(isMemoryMarkdown(ext)).toBe(false);
    }
  });
});

describe('MemoryTool view — a markdown file renders as a document', () => {
  test('a heading element appears, not the literal `#`', () => {
    const output = viewOutput('.kortix/memory/notes.md', [
      '# Deploy notes',
      '',
      '- run the migration',
    ]);
    const markup = render(memoryPart({ command: 'view', path: '.kortix/memory/notes.md' }, output), true);

    const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(markup);
    expect(heading?.[1]).toBe('Deploy notes');
    // The un-parsed source never reaches the page.
    expect(markup).not.toContain('# Deploy notes');
    expect(markup).toContain('run the migration');
  });

  test('a leading frontmatter block renders as the metadata card, not a stray rule', () => {
    // Same split `file-viewer.tsx` uses: read raw, a leading `---\n…\n---`
    // parses as a thematic break followed by a setext heading, not metadata.
    const output = viewOutput('.kortix/memory/agent.md', [
      '---',
      'name: scout',
      '---',
      '# Scout',
      'Finds things.',
    ]);
    const markup = render(memoryPart({ command: 'view', path: '.kortix/memory/agent.md' }, output), true);

    expect(markup).toContain('scout');
    const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(markup);
    expect(heading?.[1]).toBe('Scout');
    // The frontmatter fences never surface as their own paragraph/rule text.
    expect(markup).not.toContain('name: scout');
  });

  test('a .json view keeps the highlighted code card — no markdown parsing', () => {
    const output = viewOutput('.kortix/memory/config.json', ['# not a heading', 'value: 1']);
    const markup = render(
      memoryPart({ command: 'view', path: '.kortix/memory/config.json' }, output),
      true,
    );

    expect(markup).not.toContain('<h1');
    expect(markup).toContain('# not a heading');
  });
});

describe('MemoryTool create — the same markdown/code split', () => {
  test('a markdown create body renders as a document', () => {
    const markup = render(
      memoryPart({
        command: 'create',
        path: '.kortix/memory/plan.md',
        file_text: '## Plan\n\nDo the thing.',
      }),
      true,
    );

    const heading = /<h2[^>]*>([^<]*)<\/h2>/.exec(markup);
    expect(heading?.[1]).toBe('Plan');
    expect(markup).not.toContain('## Plan');
    expect(markup).toContain('Do the thing.');
  });

  test('a .json create body keeps the code card — no markdown parsing', () => {
    const markup = render(
      memoryPart({
        command: 'create',
        path: '.kortix/memory/config.json',
        file_text: '# not a heading\nvalue: 1',
      }),
      true,
    );

    expect(markup).not.toContain('<h1');
    expect(markup).not.toContain('<h2');
    expect(markup).toContain('# not a heading');
  });
});
