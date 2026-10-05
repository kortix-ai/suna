import { describe, expect, test } from 'bun:test';
import { memoryRelPath, parseMemoryView } from '@kortix/sdk';
import {
  getMemFilesReadLabel,
  getMemTrigger,
  hitPreview,
  isMemoryMarkdown,
  memoryConfidenceLabel,
  memoryResultCountLabel,
  memoryRowTarget,
  memorySearchHitSourceLabel,
  memorySearchTitle,
  memoryToolBody,
  memoryToolInput,
  memoryToolTitle,
} from './projects-memory';
import { parseMemoryEntryOutput } from './projects-memory-entry-output';
import { parseMemorySearchOutput } from './projects-memory-search-output';

// ─── memory (port of apps/web memory-tool.test.tsx) ──────────────────────────

/** A `view`'s raw output, in the runtime's "content of X with line numbers" shape. */
function viewOutput(path: string, lines: string[]): string {
  return [`Content of ${path} with line numbers:`, ...lines.map((line, i) => `${i + 1}\t${line}`)].join('\n');
}

function viewOutputEndingInNewline(path: string, lines: string[]): string {
  const numbered = [...lines, ''].map((line, i) => `${i + 1}\t${line}`);
  return [`Content of ${path} with line numbers:`, ...numbered].join('\n');
}

function body(input: Record<string, unknown>, output = '', status = 'completed', isStreaming = false) {
  return memoryToolBody(memoryToolInput(input, {}), output, status, isStreaming);
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
    expect(memoryRelPath(openPath)).toBe(subtitle as string);
  });

  test('a rename with no destination in its input falls back to the source, for BOTH', () => {
    const { openPath, subtitle } = memoryRowTarget('rename', DRAFT, '');
    expect(openPath).toBe(DRAFT);
    expect(memoryRelPath(openPath)).toBe(subtitle as string);
  });

  test('every other command targets its own path', () => {
    for (const command of ['view', 'create', 'insert', 'str_replace', 'delete']) {
      const { openPath, subtitle } = memoryRowTarget(command, FINAL, '');
      expect(openPath).toBe(FINAL);
      expect(memoryRelPath(openPath)).toBe(subtitle as string);
    }
  });

  test('the memory root and an empty path earn no subtitle, and stay in step', () => {
    const root = memoryRowTarget('view', '.kortix/memory', '');
    expect(root.openPath).toBe('.kortix/memory');
    expect(root.subtitle).toBeUndefined();

    const nothing = memoryRowTarget('', '', '');
    expect(nothing.openPath).toBe('');
    expect(nothing.subtitle).toBeUndefined();
  });
});

describe('memoryToolInput — the trigger says what happened, and to what', () => {
  test('a write titles itself an update and names the file it wrote', () => {
    const m = memoryToolInput({ command: 'str_replace', path: '.kortix/memory/notes/deploy.md' }, {});
    expect(memoryToolTitle(m.command)).toBe('Memory updated');
    expect(m.subtitle).toBe('notes/deploy.md');
    expect(m.canOpen).toBe(true);
  });

  test('a read titles itself a read', () => {
    const m = memoryToolInput({ command: 'view', path: '.kortix/memory/notes/deploy.md' }, {});
    expect(memoryToolTitle(m.command)).toBe('Memory read');
    expect(m.subtitle).toBe('notes/deploy.md');
  });

  test('a rename is named by its DESTINATION, not by the name that is gone', () => {
    const m = memoryToolInput(
      { command: 'rename', old_path: '.kortix/memory/draft.md', new_path: '.kortix/memory/notes/final.md' },
      {},
    );
    expect(m.subtitle).toBe('notes/final.md');
    expect(m.openPath).toBe('.kortix/memory/notes/final.md');
  });

  test('a completed rename carrying no new_path is labelled by its source', () => {
    expect(memoryToolInput({ command: 'rename', old_path: '.kortix/memory/draft.md' }, {}).subtitle).toBe('draft.md');
  });

  test('viewing the memory root shows no subtitle and a directory offers no tap', () => {
    const m = memoryToolInput({ command: 'view', path: '.kortix/memory' }, {});
    expect(m.subtitle).toBeUndefined();
    expect(m.canOpen).toBe(false);
  });

  test('a call with no command and no path is still a titled row, never blank', () => {
    const m = memoryToolInput({}, {});
    expect(memoryToolTitle(m.command)).toBe('Memory');
    expect(m.canOpen).toBe(false);
  });

  test('delete never opens the file it removed; streaming input fills the gaps', () => {
    expect(memoryToolInput({ command: 'delete', path: '.kortix/memory/a.md' }, {}).canOpen).toBe(false);
    const streaming = memoryToolInput({}, { command: 'create', path: '.kortix/memory/b.json', file_text: '{}' });
    expect(streaming).toMatchObject({ command: 'create', ext: 'json', fileText: '{}', canOpen: true });
  });
});

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

describe('memoryToolBody — which body each command shows', () => {
  test('view of a markdown file renders as a document', () => {
    const output = viewOutput('.kortix/memory/notes.md', ['# Deploy notes', '', '- run the migration']);
    expect(body({ command: 'view', path: '.kortix/memory/notes.md' }, output)).toEqual({
      kind: 'markdown',
      code: '# Deploy notes\n\n- run the migration',
    });
  });

  test('view of a .json file keeps the highlighted code card', () => {
    const output = viewOutput('.kortix/memory/config.json', ['# not a heading', 'value: 1']);
    expect(body({ command: 'view', path: '.kortix/memory/config.json' }, output)).toEqual({
      kind: 'code',
      code: '# not a heading\nvalue: 1',
      language: 'json',
    });
  });

  test('view of a directory lists relative names and sizes; an empty one says so', () => {
    const output = 'files and directories in .kortix/memory:\n120\t.kortix/memory/notes.md\n4K\t.kortix/memory/decisions';
    expect(body({ command: 'view', path: '.kortix/memory' }, output)).toEqual({
      kind: 'dir',
      entries: [
        { key: '.kortix/memory/notes.md', name: 'notes.md', size: '120' },
        { key: '.kortix/memory/decisions', name: 'decisions', size: '4K' },
      ],
    });
    expect(body({ command: 'view', path: '.kortix/memory' }, 'files and directories in .kortix/memory:')).toEqual({
      kind: 'empty',
      message: 'Memory is empty.',
    });
  });

  test('view with no output: reading while streaming, nothing to show after', () => {
    expect(body({ command: 'view', path: 'x' }, '', 'running', true)).toEqual({ kind: 'empty', message: 'Reading memory…' });
    expect(body({ command: 'view', path: 'x' }, '')).toEqual({ kind: 'empty', message: 'Nothing to show.' });
    expect(body({ command: 'view', path: 'x' }, 'unrecognised')).toEqual({ kind: 'fallback' });
  });

  test('create: the same markdown/code split over file_text', () => {
    expect(body({ command: 'create', path: '.kortix/memory/plan.md', file_text: '## Plan\n\nDo the thing.' })).toEqual({
      kind: 'markdown',
      code: '## Plan\n\nDo the thing.',
    });
    expect(body({ command: 'create', path: '.kortix/memory/c.json', file_text: '# not a heading' })).toEqual({
      kind: 'code',
      code: '# not a heading',
      language: 'json',
    });
    expect(body({ command: 'create', path: 'a.md' }, '', 'running', true)).toEqual({ kind: 'empty', message: 'Writing memory…' });
    expect(body({ command: 'create', path: 'a.md' })).toEqual({ kind: 'empty', message: 'No content.' });
  });

  test('str_replace: a diff, a no-op notice, or the failure text', () => {
    expect(body({ command: 'str_replace', path: '.kortix/memory/a.md', old_str: 'a', new_str: 'b' })).toEqual({
      kind: 'diff',
      oldStr: 'a',
      newStr: 'b',
      filename: 'a.md',
    });
    expect(body({ command: 'str_replace', path: 'a.md' })).toEqual({ kind: 'empty', message: 'No changes.' });
    expect(body({ command: 'str_replace', path: 'a.md' }, 'No replacement was performed, old_str did not appear')).toEqual({
      kind: 'error',
    });
  });

  test('insert, rename, delete', () => {
    expect(body({ command: 'insert', path: 'a.md', insert_line: 3, insert_text: 'x' })).toEqual({
      kind: 'insert',
      line: '3',
      text: 'x',
      language: 'md',
    });
    expect(body({ command: 'insert', path: 'a.md' })).toEqual({ kind: 'empty', message: 'Nothing inserted.' });
    expect(
      body({ command: 'rename', old_path: '.kortix/memory/draft.md', new_path: '.kortix/memory/notes/final.md' }),
    ).toEqual({ kind: 'rename', from: 'draft.md', to: 'notes/final.md' });
    expect(body({ command: 'delete', path: '.kortix/memory/a.md' })).toEqual({ kind: 'delete', path: 'a.md' });
  });

  test('an errored completed call, or an unknown command with output, falls back', () => {
    expect(body({ command: 'create', path: 'a.md', file_text: 'x' }, '{"success":false,"error":"nope"}')).toEqual({
      kind: 'fallback',
    });
    expect(body({ command: 'mystery' }, 'some output')).toEqual({ kind: 'fallback' });
    expect(body({ command: 'mystery' })).toEqual({ kind: 'none' });
  });
});

describe('parseMemoryView — a file that ends with a newline', () => {
  test('the trailing bare line number is stripped, not kept as content', () => {
    const raw = viewOutputEndingInNewline('.kortix/memory/notes.md', ['# Deploy notes', '', '- run the migration']);
    const view = parseMemoryView(raw.trim(), '.kortix/memory/notes.md');
    expect(view?.type).toBe('file');
    const content = view?.type === 'file' ? view.content : '';
    expect(content).toBe('# Deploy notes\n\n- run the migration\n');
  });

  test('a numbered line whose content IS a number is still content', () => {
    const raw = ['Content of .kortix/memory/n.md with line numbers:', '1\t4', '2\tfour'].join('\n');
    const view = parseMemoryView(raw, '.kortix/memory/n.md');
    expect(view?.type === 'file' ? view.content : '').toBe('4\nfour');
  });

  test('end to end: the markdown body does not end in a stray number', () => {
    const raw = viewOutputEndingInNewline('.kortix/memory/notes.md', ['# Deploy notes', '', '- run the migration']);
    const result = body({ command: 'view', path: '.kortix/memory/notes.md' }, raw.trim());
    expect(result.kind).toBe('markdown');
    expect(result.kind === 'markdown' ? result.code.trimEnd().endsWith('- run the migration') : false).toBe(true);
  });
});

// ─── memory search (port of apps/web memory-search-tool.test.tsx) ────────────

const SEARCH_OUTPUT = JSON.stringify({
  query: 'competitor pricing notes',
  source: 'ltm',
  results: [
    {
      id: 'mem_204',
      type: 'note',
      source: 'ltm',
      confidence: 0.86,
      content:
        'User previously flagged that Acme undercuts on annual billing discounts — check before finalizing the comparison.',
      files: ['docs/pricing.md'],
    },
  ],
});

describe('memory search', () => {
  test('the hit identity line: source/type, id, confidence, preview, result count', () => {
    const parsed = parseMemorySearchOutput(SEARCH_OUTPUT);
    expect(memorySearchTitle(parsed.label)).toBe('LTM Search');
    expect(parsed.hits).toHaveLength(1);
    const hit = parsed.hits[0];
    expect(`${memorySearchHitSourceLabel(hit.source)} / ${hit.type}`).toBe('LTM / note');
    expect(hit.id).toBe('mem_204');
    expect(memoryConfidenceLabel(hit.confidence)).toBe('86% conf');
    expect(hitPreview(hit.content)).toBe(
      'User previously flagged that Acme undercuts on annual billing discounts — check…',
    );
    expect(hitPreview(hit.content)).not.toContain('finalizing the comparison');
    expect(memoryResultCountLabel(1)).toBe('1 result');
    expect(memoryResultCountLabel(0)).toBe('0 results');
  });

  test('a non-LTM label titles the row "Memory Search"; observation hits say so', () => {
    expect(memorySearchTitle('Memory Search')).toBe('Memory Search');
    expect(memorySearchHitSourceLabel('obs')).toBe('Observation');
    expect(memorySearchHitSourceLabel('unknown')).toBe('Memory');
    expect(memoryConfidenceLabel(null)).toBeNull();
  });

  test('the text format parses too', () => {
    const parsed = parseMemorySearchOutput(
      '=== LTM Search: "pricing" (1 results) ===\n[LTM/fact] #12 (confidence: 0.5)\n  Acme is cheaper\n  Files: a.md, b.md',
    );
    expect(parsed).toMatchObject({ matched: true, label: 'LTM Search', query: 'pricing', declaredResults: 1 });
    expect(parsed.hits).toEqual([
      { source: 'ltm', type: 'fact', id: '12', confidence: 0.5, content: 'Acme is cheaper', files: ['a.md', 'b.md'] },
    ]);
  });
});

describe('hitPreview', () => {
  test('takes the first non-empty line, not the whole body', () => {
    expect(hitPreview('\n\nFirst line\nsecond line\nthird')).toBe('First line');
  });

  test('a long line is truncated with an ellipsis so the row stays one line', () => {
    const preview = hitPreview('x'.repeat(200));
    expect(preview).toHaveLength(80);
    expect(preview.endsWith('…')).toBe(true);
  });

  test('a short single-line memory is shown whole', () => {
    expect(hitPreview('User prefers dark mode')).toBe('User prefers dark mode');
  });
});

// ─── get_mem (port of apps/web get-mem-tool.test.tsx) ────────────────────────

const OBSERVATION_OUTPUT = `=== Observation #42 [insight] ===
Title: Refactored auth flow
Narrative:
Simplified the login flow by removing redundant redirects.
Tool: edit_file | Prompt #7
Session: sess-99
Created: 2026-07-01
Facts:
- Removed duplicate middleware
Concepts: auth, refactor
Files read: src/auth.ts, src/login.tsx`;

const LTM_OUTPUT = `=== LTM #9 [fact] ===
Caption: User prefers dark mode
Content: The user explicitly asked for dark mode as default across all surfaces.
Session: sess-1
Created: 2026-06-01 | Updated: 2026-06-15
Tags: preference, ui`;

describe('get_mem', () => {
  test('observation content is preserved: title, narrative, call provenance', () => {
    const report = parseMemoryEntryOutput(OBSERVATION_OUTPUT);
    if (report?.kind !== 'observation') throw new Error('expected an observation');
    expect(report.title).toBe('Refactored auth flow');
    expect(report.narrative).toContain('Simplified the login flow');
    expect(report.tool).toBe('edit_file');
    expect(report.prompt).toBe('7');
    expect(report.session).toBe('sess-99');
    expect(report.created).toBe('2026-07-01');
    expect(report.facts).toEqual(['Removed duplicate middleware']);
    expect(report.concepts).toEqual(['auth', 'refactor']);
    expect(report.filesRead).toEqual(['src/auth.ts', 'src/login.tsx']);
    expect(getMemFilesReadLabel(report.filesRead.length)).toBe('Files read (2)');
  });

  test('LTM caption, content, session, tags', () => {
    const report = parseMemoryEntryOutput(LTM_OUTPUT);
    if (report?.kind !== 'ltm') throw new Error('expected an LTM entry');
    expect(report.caption).toBe('User prefers dark mode');
    expect(report.content).toContain('The user explicitly asked for dark mode');
    expect(report.session).toBe('sess-1');
    expect(report.updated).toBe('2026-06-15');
    expect(report.tags).toEqual(['preference', 'ui']);
  });

  test("the closed row: an observation's title is the subtitle, its id is the badge", () => {
    expect(getMemTrigger({ id: 42 }, parseMemoryEntryOutput(OBSERVATION_OUTPUT))).toEqual({
      title: 'Recalled',
      subtitle: 'Refactored auth flow',
      badge: '#42',
    });
  });

  test('an LTM entry falls back to its caption', () => {
    expect(getMemTrigger({ id: 9 }, parseMemoryEntryOutput(LTM_OUTPUT))).toEqual({
      title: 'Recalled',
      subtitle: 'User prefers dark mode',
      badge: '#9',
    });
  });

  test('with nothing parsed, the id is still the subtitle — never an empty row', () => {
    expect(getMemTrigger({ id: 77 }, parseMemoryEntryOutput('still thinking…'))).toEqual({
      title: 'Recalled',
      subtitle: '#77',
      badge: undefined,
    });
  });
});
