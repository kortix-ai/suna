import { describe, expect, test } from 'bun:test';

import type { ContextItem, OutputItem } from '../../action-panel/shared/derive-panels';
import { filterSlashFiles, sessionSlashFiles, type SlashFile } from './slash-files';

const output = (partial: Partial<OutputItem> & { path?: string }): OutputItem =>
  ({
    callID: partial.callID ?? `call-${partial.path ?? partial.name}`,
    name: partial.name ?? 'file',
    kind: partial.kind ?? 'file',
    ...partial,
  }) as OutputItem;

const ctx = (path: string, label = path.split('/').pop() ?? path): ContextItem => ({
  callID: `ctx-${path}`,
  label,
  kind: 'file',
  path,
});

describe('sessionSlashFiles', () => {
  test('no panel data produces no rows', () => {
    expect(sessionSlashFiles({ outputs: [], contextFiles: [] })).toEqual([]);
  });

  test('an output becomes one row: path, basename, folder, origin', () => {
    const files = sessionSlashFiles({
      outputs: [output({ path: 'docs/report.md', name: 'report.md' })],
      contextFiles: [],
    });
    expect(files).toEqual([
      { path: 'docs/report.md', name: 'report.md', folder: 'docs', origin: 'output' },
    ]);
  });

  test('a file at the workspace root reports an empty folder', () => {
    const [file] = sessionSlashFiles({
      outputs: [output({ path: 'README.md', name: 'README.md' })],
      contextFiles: [],
    });
    expect(file.folder).toBe('');
  });

  // The display rule `OutputItemBase.title` documents — the palette has to call
  // a deliverable what the Outputs card calls it.
  test('an output with a title shows the title, not the filename', () => {
    const [file] = sessionSlashFiles({
      outputs: [output({ path: 'out/q3.pdf', name: 'q3.pdf', title: 'Q3 revenue report' })],
      contextFiles: [],
    });
    expect(file.name).toBe('Q3 revenue report');
    expect(file.path).toBe('out/q3.pdf');
  });

  // The whole point of the `path` field: it is the mention's label, so an
  // absolute sandbox write has to arrive workspace-relative or the agent gets
  // a `<file_ref>` in a shape the daemon does not serve.
  test('an absolute /workspace path is normalized to workspace-relative', () => {
    const [file] = sessionSlashFiles({
      outputs: [output({ path: '/workspace/src/app.ts', name: 'app.ts' })],
      contextFiles: [],
    });
    expect(file.path).toBe('src/app.ts');
  });

  test('a ./-prefixed and a backslash path normalize to the same shape', () => {
    const files = sessionSlashFiles({
      outputs: [output({ path: './src/app.ts', name: 'app.ts' })],
      contextFiles: [ctx('src\\app.ts', 'app.ts')],
    });
    expect(files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  test('non-workspace sandbox roots stay absolute', () => {
    const [file] = sessionSlashFiles({
      outputs: [output({ path: '/tmp/scratch.log', name: 'scratch.log' })],
      contextFiles: [],
    });
    expect(file.path).toBe('/tmp/scratch.log');
  });

  // A file written and then re-read must offer ONE row. Two rows would insert
  // the identical mention twice and read as two different files.
  test('a file in both Outputs and Context appears once, as an output', () => {
    const files = sessionSlashFiles({
      outputs: [output({ path: '/workspace/report.md', name: 'report.md' })],
      contextFiles: [ctx('report.md')],
    });
    expect(files).toHaveLength(1);
    expect(files[0].origin).toBe('output');
  });

  test('duplicate outputs collapse to one row', () => {
    const files = sessionSlashFiles({
      outputs: [
        output({ callID: 'a', path: 'a.md', name: 'a.md' }),
        output({ callID: 'b', path: '/workspace/a.md', name: 'a.md' }),
      ],
      contextFiles: [],
    });
    expect(files).toHaveLength(1);
  });

  // An `app` output is a URL on a port — there is no path to reference.
  test('running apps are skipped', () => {
    const files = sessionSlashFiles({
      outputs: [
        output({ kind: 'app', name: 'Landing page', url: 'http://localhost:3000' }),
        output({ path: 'index.html', name: 'index.html' }),
      ],
      contextFiles: [],
    });
    expect(files.map((f) => f.name)).toEqual(['index.html']);
  });

  test('a context item with no path is skipped', () => {
    const files = sessionSlashFiles({
      outputs: [],
      contextFiles: [{ callID: 'x', label: 'grep', kind: 'tool' }],
    });
    expect(files).toEqual([]);
  });

  // The panel already ranked its outputs (`session-panel-provider.tsx`'s
  // `files` memo). Re-sorting here would make the palette and the card
  // disagree about which file matters most.
  test('the given output order is preserved, and outputs precede context', () => {
    const files = sessionSlashFiles({
      outputs: [
        output({ path: 'second.md', name: 'second.md' }),
        output({ path: 'first.md', name: 'first.md' }),
      ],
      contextFiles: [ctx('notes.txt')],
    });
    expect(files.map((f) => f.name)).toEqual(['second.md', 'first.md', 'notes.txt']);
    expect(files.map((f) => f.origin)).toEqual(['output', 'output', 'context']);
  });
});

describe('filterSlashFiles', () => {
  const files: SlashFile[] = sessionSlashFiles({
    outputs: [
      output({ path: 'docs/report.md', name: 'Q3 revenue report' }),
      output({ path: 'src/app.ts', name: 'app.ts' }),
    ],
    contextFiles: [ctx('src/util.ts')],
  });

  test('an empty query returns every file', () => {
    expect(filterSlashFiles(files, '')).toHaveLength(3);
  });

  test('whitespace-only query returns every file', () => {
    expect(filterSlashFiles(files, '   ')).toHaveLength(3);
  });

  // Matching the path, not only the row's display name — `/docs` has to find a
  // file whose row reads "Q3 revenue report".
  test('the query matches the folder in the path', () => {
    expect(filterSlashFiles(files, 'docs').map((f) => f.path)).toEqual(['docs/report.md']);
  });

  test('the query matches an output title that is nothing like its filename', () => {
    expect(filterSlashFiles(files, 'revenue').map((f) => f.path)).toEqual(['docs/report.md']);
  });

  test('matching is case-insensitive', () => {
    expect(filterSlashFiles(files, 'APP.TS').map((f) => f.path)).toEqual(['src/app.ts']);
  });

  test('a query that matches nothing returns nothing', () => {
    expect(filterSlashFiles(files, 'zzz')).toEqual([]);
  });

  test('the input array is never mutated', () => {
    const before = [...files];
    filterSlashFiles(files, 'src');
    expect(files).toEqual(before);
  });
});
