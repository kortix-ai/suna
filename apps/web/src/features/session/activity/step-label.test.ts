import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '@/ui';
import { stepDetail, stepLabel } from './step-label';

function part(tool: string, input: Record<string, unknown> = {}): Pick<ToolPart, 'tool' | 'state'> {
  return { tool, state: { status: 'completed', input } } as unknown as Pick<
    ToolPart,
    'tool' | 'state'
  >;
}

describe('stepLabel', () => {
  test("a shell step uses the model's own description", () => {
    expect(
      stepLabel(
        part('bash', {
          description: 'Build slide 7 — Uber and Robinhood',
          command: 'python3 x.py',
        }),
      ),
    ).toBe('Build slide 7 — Uber and Robinhood');
  });

  test('a shell step with no description falls back to the command shape', () => {
    expect(stepLabel(part('bash', { command: 'npm install' }))).toBe('Installed dependencies');
  });

  test('file tools read as a sentence, not as a tool name', () => {
    // The old fallback produced "write · index.html", which reads like a log.
    expect(stepLabel(part('write', { filePath: '/workspace/deck/index.html' }))).toBe(
      'Wrote index.html',
    );
    expect(stepLabel(part('read', { filePath: '/workspace/deck/manifest.json' }))).toBe(
      'Read manifest.json',
    );
    expect(stepLabel(part('edit', { filePath: 'src/app.ts' }))).toBe('Edited app.ts');
  });

  test('search tools name what was searched for', () => {
    expect(stepLabel(part('grep', { pattern: 'TODO' }))).toBe('Searched for TODO');
    expect(stepLabel(part('web_search', { query: 'calacanis portfolio' }))).toBe(
      'Searched the web for calacanis portfolio',
    );
  });

  test('a URL argument keeps its host — that is the identifying part', () => {
    expect(stepLabel(part('webfetch', { url: 'https://www.example.com/a/b/c?q=1' }))).toBe(
      'Fetched example.com',
    );
  });

  test('a known tool with no argument still reads as a verb', () => {
    expect(stepLabel(part('read'))).toBe('Read');
  });

  test('an unknown tool is de-slugged rather than shown raw', () => {
    expect(stepLabel(part('oc-presentation-gen'))).toBe('Presentation gen');
    expect(stepLabel(part('custom_thing', { path: '/a/b/thing.txt' }))).toBe(
      'Custom thing · thing.txt',
    );
  });

  test('never leaks a raw shell command', () => {
    const label = stepLabel(
      part('bash', { command: 'cd /workspace && SCRIPT=/very/long/path.py && python3 $SCRIPT' }),
    );
    expect(label).not.toContain('/workspace');
    expect(label).not.toContain('&&');
  });
});

describe('stepDetail (the EXPANDED reading)', () => {
  test('a shell step shows the command itself, not "Ran a command"', () => {
    // Eleven rows of "Ran a command" are indistinguishable — the reason this
    // exists separately from stepLabel.
    const d = stepDetail(part('bash', { command: 'kortix executor call gmail find_email' }));
    expect(d.shell).toBe(true);
    expect(d.verb).toBe('');
    expect(d.mono).toBe('kortix executor call gmail find_email');
  });

  test('a multi-line command is cut to its first line so a row keeps its height', () => {
    const d = stepDetail(part('bash', { command: "cat <<'EOF'\nline two\nline three\nEOF" }));
    expect(d.mono).toBe("cat <<'EOF'");
  });

  test("the model's description does NOT replace the command here", () => {
    // stepLabel prefers the description; the expanded row must stay concrete.
    const d = stepDetail(part('bash', { description: 'Check the inbox', command: 'ls -la' }));
    expect(d.mono).toBe('ls -la');
  });

  test('file steps keep the FULL path — two files can share a basename', () => {
    const d = stepDetail(part('read', { filePath: 'src/app/page.tsx' }));
    expect(d.verb).toBe('Read');
    expect(d.mono).toBe('src/app/page.tsx');
    expect(d.shell).toBe(false);
  });

  test('a step with no argument still names itself', () => {
    expect(stepDetail(part('read')).verb).toBe('Read');
    expect(stepDetail(part('read')).mono).toBe('');
  });
});
