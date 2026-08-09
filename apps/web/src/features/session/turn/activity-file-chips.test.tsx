import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import type { Part, ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFileChipStep, isFileChipPart } from './activity-file-chips';

function tool(id: string, name: string, state: Record<string, unknown>): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state,
  } as unknown as ToolPart;
}

const read = (id: string, filePath: string): ToolPart =>
  tool(id, 'read', { status: 'completed', output: 'contents', input: { filePath } });

/** Chips announce themselves as `Open <name>` — the count of them is the count
 *  of files the row actually opened. */
const chipCount = (markup: string) => markup.split('aria-label="Open ').length - 1;

const render = (parts: Part[], { open = true, running = false, bare = false } = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ChainOfThoughtStep open={open}>
          <ActivityFileChipStep
            parts={parts}
            running={running}
            bare={bare}
            sessionId="session-1"
            disableNavigation
          />
        </ChainOfThoughtStep>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('isFileChipPart', () => {
  test('whole-file reads and writes are chips', () => {
    expect(isFileChipPart(tool('1', 'read', { status: 'completed' }))).toBe(true);
    expect(isFileChipPart(tool('2', 'write', { status: 'completed' }))).toBe(true);
  });

  test('edits are not — their renderer shows a diff, which is the right output', () => {
    expect(isFileChipPart(tool('1', 'edit', { status: 'completed' }))).toBe(false);
    expect(isFileChipPart(tool('2', 'apply_patch', { status: 'completed' }))).toBe(false);
  });

  test('a shell command and a thought are not files', () => {
    expect(isFileChipPart(tool('1', 'bash', { status: 'completed' }))).toBe(false);
    expect(
      isFileChipPart({ id: 'r', type: 'reasoning', text: 'thinking' } as unknown as Part),
    ).toBe(false);
  });

  test('an `oc-` alias resolves to the same family', () => {
    // Normalization is the one door every turn module uses; a chip row that
    // matched raw names would silently drop the aliased half of the traffic.
    expect(isFileChipPart(tool('1', 'oc-read', { status: 'completed' }))).toBe(true);
  });
});

describe('ActivityFileChipStep', () => {
  const three: Part[] = [
    read('1', '/workspace/package.json'),
    read('2', '/workspace/README.md'),
    read('3', '/workspace/notes.txt'),
  ];

  test('a run of three reads opens to three files, named and typed', () => {
    const markup = render(three);
    expect(markup).toContain('Read 3 files');
    expect(chipCount(markup)).toBe(3);
    expect(markup).toContain('package.json');
    expect(markup).toContain('README.md');
    expect(markup).toContain('notes.txt');
    // The second line is the file's type, from the same table the user's own
    // attachment tiles read.
    expect(markup).toContain('JSON');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Text');
  });

  test('closed, the run is ONE row and no file is rendered', () => {
    const markup = render(three, { open: false });
    expect(markup).toContain('Read 3 files');
    expect(chipCount(markup)).toBe(0);
    expect(markup).not.toContain('package.json');
  });

  test('a bare row keeps the indent that gives the chain rail its lane', () => {
    // A bare row drops the ICON, not the rail. The rail runs at `left-2`, so a
    // chip flush to the margin has the hairline through its left edge.
    const markup = render([read('1', '/workspace/pdf.ts')], { bare: true });
    expect(markup).toContain('pl-7');
  });

  test('a run of one is still a file — one chip, singular label', () => {
    // `mergeBurstSteps` unwraps a group of one, so this row is reached with a
    // single part. A read is a FILE, and one file is still a file.
    const markup = render([read('1', '/workspace/main.ts')]);
    // A single file names itself rather than counting to one.
    expect(markup).toContain('Read /workspace/main.ts');
    expect(chipCount(markup)).toBe(1);
  });

  test('the same file read twice is one chip, and the label names it once', () => {
    // The label describes what is below it. A label counting PARTS would
    // promise two files and open to one.
    const markup = render([read('1', '/workspace/main.ts'), read('2', '/workspace/main.ts')]);
    expect(markup).toContain('Read /workspace/main.ts');
    expect(chipCount(markup)).toBe(1);
  });

  test('a read with no resolvable path gets no chip', () => {
    // Input still streaming: there is nothing to preview, so the part falls
    // back to an ordinary step row rather than an empty chip.
    const markup = render([tool('1', 'read', { status: 'completed', input: {} })]);
    expect(chipCount(markup)).toBe(0);
    expect(markup).toContain('Read 1 file');
  });

  test('a pending read resolves its path from the streaming input', () => {
    const markup = render([
      tool('1', 'read', { status: 'pending', raw: '{"filePath":"/workspace/main.ts"' }),
    ]);
    expect(chipCount(markup)).toBe(1);
    expect(markup).toContain('main.ts');
  });

  test('writes get their own verb', () => {
    const markup = render([
      tool('1', 'write', { status: 'completed', input: { filePath: '/workspace/a.ts' } }),
      tool('2', 'write', { status: 'completed', input: { filePath: '/workspace/b.ts' } }),
    ]);
    expect(markup).toContain('Wrote 2 files');
  });

  test('a member still in flight shimmers and reads in the present tense', () => {
    const markup = render(
      [read('1', '/workspace/a.ts'), tool('2', 'read', { status: 'running', input: {} })],
      { running: true },
    );
    expect(markup).toContain('Reading 2 files');
    expect(markup).toContain('data-status="running"');
    // `bg-clip-text` is `TextShimmer`'s signature.
    expect(markup).toContain('bg-clip-text');
  });

  test('a failed read is not a chip — it has nothing to preview', () => {
    const markup = render([
      read('1', '/workspace/a.ts'),
      tool('2', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
    ]);
    expect(chipCount(markup)).toBe(1);
    expect(markup).not.toContain('aria-label="Open gone.ts"');
    // Still two things below the row, so the label still says two.
    expect(markup).toContain('Read 2 files');
  });

  test('a directory listing is not a chip — it has its own renderer', () => {
    // `read` legitimately lists a directory, and `read-tool.tsx` renders the
    // entry list. A chip would point the file preview at a folder, and the
    // listing the reader used to get would be unreachable.
    const markup = render([
      tool('1', 'read', {
        status: 'completed',
        output: '<path>/workspace/src</path>\n<entries>\nmain.ts\nutil.ts\n</entries>',
        input: { filePath: '/workspace/src' },
      }),
    ]);
    expect(chipCount(markup)).toBe(0);
    expect(markup).toContain('Read 1 file');
  });

  test('a trailing slash is a directory too, before any output arrives', () => {
    // `getFilename('/workspace/src/')` returns the literal string "file", so a
    // chip here would be labelled `file` / `File`.
    const markup = render([
      tool('1', 'read', { status: 'running', input: { filePath: '/workspace/src/' } }),
      read('2', '/workspace/main.ts'),
    ]);
    expect(chipCount(markup)).toBe(1);
    expect(markup).not.toContain('aria-label="Open file"');
  });

  test('an unknown extension shows the extension, not the word File', () => {
    // `getFileType` knows twelve groups; `.yml` is not one of them, so
    // `getTypeLabel` degrades to "File" — a line with no information on it.
    const markup = render([read('1', '/workspace/compose.yml')]);
    expect(markup).toContain('YML');
    expect(markup).not.toContain('>File<');
  });

  test('a run holding a failure says so in words, not only in the glyph', () => {
    // `Read 2 files` alone is the row claiming both landed — the same lie
    // `group-steps.ts` forbids by routing a failed group through
    // `narrateFailedStep`. The clause is the collapsed title's, verbatim.
    const markup = render([
      read('1', '/workspace/a.ts'),
      tool('2', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
    ]);
    expect(markup).toContain('Read 2 files · 1 failed');
  });

  test('a run still in flight states no failure count — it is not over', () => {
    const markup = render(
      [
        tool('1', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
        tool('2', 'read', { status: 'running', input: { filePath: '/workspace/a.ts' } }),
      ],
      { running: true },
    );
    expect(markup).toContain('Reading 2 files');
    expect(markup).not.toContain('· 1 failed');
  });

  test('a run holding a failure carries the destructive mark on its row', () => {
    const markup = render(
      [
        read('1', '/workspace/a.ts'),
        tool('2', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
      ],
      { open: false },
    );
    expect(markup).toContain('data-status="error"');
    expect(markup).toContain('aria-label="This step failed"');
    expect(markup).toContain('text-destructive');
  });

  test('a call that RETURNED its error is a failure too, not a chip', () => {
    // `state.status === 'error'` alone would hand a chip to a read that never
    // opened anything — the same gap `partOutcome` exists to close.
    const markup = render([
      tool('1', 'read', {
        status: 'completed',
        output: 'Error: ENOENT: no such file or directory',
        input: { filePath: '/gone.ts' },
      }),
    ]);
    expect(chipCount(markup)).toBe(0);
    expect(markup).toContain('data-status="error"');
  });

  test('a clean settled run carries no failure mark', () => {
    const markup = render(three, { open: false });
    expect(markup).toContain('data-status="done"');
    expect(markup).not.toContain('aria-label="This step failed"');
    expect(markup).not.toContain('text-destructive');
  });

  test('nothing renders for a run that is not a file family', () => {
    // Guard against a caller wiring this row to the wrong parts: the row draws
    // no trigger at all rather than inventing a verb for a shell command.
    const markup = render([tool('1', 'bash', { status: 'completed', input: { command: 'ls' } })]);
    expect(markup).not.toContain('data-status');
    expect(markup).not.toContain('file');
  });
});
