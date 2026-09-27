import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@kortix/sdk';

import {
  cleanErrorMessage,
  firstMeaningfulLine,
  getAgentCardLabel,
  isErrorOutput,
  isLocalSandboxFilePath,
  languageFromPath,
  looksLikeError,
  looksLikeMarkdown,
  parseFrontmatter,
  parseJsonFailure,
  parsePartialJSON,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
} from './tool-part-accessors';

function part(state: Record<string, unknown>, tool = 'bash'): ToolPart {
  return { id: 'prt_1', callID: 'call_1', tool, type: 'tool', state } as unknown as ToolPart;
}

describe('partStreamingInput / partInput', () => {
  test('a settled call returns its own input object', () => {
    const input = { command: 'ls' };
    const p = part({ status: 'completed', input, output: '' });
    expect(partInput(p)).toBe(input);
    expect(partStreamingInput(p)).toBe(input);
  });

  test('a streaming call parses the half-arrived raw JSON', () => {
    const p = part({ status: 'pending', input: {}, raw: '{"command": "ls -la", "descr' });
    expect(partStreamingInput(p)).toEqual({ command: 'ls -la' });
  });

  test('the parsed streaming input is memoised per part while raw is unchanged', () => {
    const p = part({ status: 'running', input: {}, raw: '{"a": "b"' });
    expect(partStreamingInput(p)).toBe(partStreamingInput(p));
  });

  test('no input and no raw returns ONE shared frozen empty object', () => {
    const a = partInput(part({ status: 'pending', input: {} }));
    const b = partInput(part({ status: 'completed' }));
    expect(a).toEqual({});
    expect(Object.isFrozen(b)).toBe(true);
  });
});

describe('parsePartialJSON', () => {
  test('complete JSON parses directly', () => {
    expect(parsePartialJSON('{"a":1}')).toEqual({ a: 1 });
  });
  test('closes open strings, brackets and braces', () => {
    expect(parsePartialJSON('{"list": ["x", "y')).toEqual({ list: ['x', 'y'] });
  });
  test('falls back to regex key extraction', () => {
    expect(parsePartialJSON('garbage "path": "/a/b" more')).toEqual({ path: '/a/b' });
  });
  test('empty input is an empty object', () => {
    expect(parsePartialJSON('')).toEqual({});
  });
});

describe('partOutput', () => {
  test('only a completed call has output', () => {
    expect(partOutput(part({ status: 'running', input: {} }))).toBe('');
  });
  test('strips bash metadata and trims', () => {
    const p = part({
      status: 'completed',
      input: {},
      output: '  hello\n<bash_metadata>{"exit":0}</bash_metadata>  ',
    });
    expect(partOutput(p)).toBe('hello');
  });
  test('is memoised per part', () => {
    const p = part({ status: 'completed', input: {}, output: 'x' });
    expect(partOutput(p)).toBe(partOutput(p));
  });
});

describe('partMetadata / partStatus', () => {
  test('metadata is read on completed, running and error', () => {
    const metadata = { diagnostics: {} };
    expect(partMetadata(part({ status: 'completed', input: {}, metadata }))).toBe(metadata);
    expect(partMetadata(part({ status: 'error', input: {}, metadata }))).toBe(metadata);
    expect(partMetadata(part({ status: 'pending', input: {}, metadata }))).toEqual({});
  });
  test('status is the raw state status', () => {
    expect(partStatus(part({ status: 'error', input: {} }))).toBe('error');
  });
});

describe('firstMeaningfulLine / getAgentCardLabel', () => {
  test('first non-empty trimmed line, capped with an ellipsis', () => {
    expect(firstMeaningfulLine('\n\n  hello world \nnext')).toBe('hello world');
    expect(firstMeaningfulLine('abcdef', 3)).toBe('abc…');
    expect(firstMeaningfulLine(42)).toBe('');
  });
  test('agent label prefers title, then description, message, prompt, agent id', () => {
    expect(getAgentCardLabel({ title: 'T', description: 'D' })).toBe('T');
    expect(getAgentCardLabel({ prompt: '\nDo the thing' })).toBe('Do the thing');
    expect(getAgentCardLabel({ agent_id: 'ag_1' })).toBe('Agent ag_1');
    expect(getAgentCardLabel({})).toBe('Worker task');
  });
});

describe('isLocalSandboxFilePath', () => {
  test('absolute sandbox paths only', () => {
    expect(isLocalSandboxFilePath('/workspace/a.png')).toBe(true);
    expect(isLocalSandboxFilePath('workspace/a.png')).toBe(false);
    expect(isLocalSandboxFilePath('https://x.com/a.png')).toBe(false);
    expect(isLocalSandboxFilePath('data:image/png;base64,xx')).toBe(false);
    expect(isLocalSandboxFilePath('')).toBe(false);
  });
});

// Ported from apps/web tool/shared/infrastructure.error.test.ts — the SDK
// implementation is re-exported, so the same contract holds on mobile.
describe('error helpers (SDK re-exports)', () => {
  test('cleanErrorMessage collapses repeated Error prefixes', () => {
    expect(cleanErrorMessage('Error: Error: boom')).toBe('boom');
  });
  test('isErrorOutput detects the {success:false} contract and plain errors', () => {
    expect(isErrorOutput('{"success":false,"error":"nope"}')).toBe(true);
    expect(isErrorOutput('Error: something failed')).toBe(true);
    expect(isErrorOutput('all good')).toBe(false);
    expect(isErrorOutput('')).toBe(false);
  });
  test('parseJsonFailure extracts a summary and ignores success payloads', () => {
    expect(parseJsonFailure('{"success":false,"error":"Error: nope"}')?.errorSummary).toContain('nope');
    expect(parseJsonFailure('{"success":true}')).toBeNull();
  });
  test('looksLikeError is exported', () => {
    expect(typeof looksLikeError).toBe('function');
  });
});

// Ported from apps/web lib/markdown-detect.ts semantics.
describe('looksLikeMarkdown', () => {
  test('unambiguous syntax matches', () => {
    expect(looksLikeMarkdown('## Heading')).toBe(true);
    expect(looksLikeMarkdown('some **bold** text')).toBe(true);
    expect(looksLikeMarkdown('see [docs](https://x.com)')).toBe(true);
    expect(looksLikeMarkdown('1. step one')).toBe(true);
  });
  test('plain text and dash bullets do not match', () => {
    expect(looksLikeMarkdown('line one\n- item\n- item')).toBe(false);
    expect(looksLikeMarkdown('Traceback: x')).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  test('splits a leading YAML block from the body, one nesting level', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: coder\npermission:\n  "*": allow\n  bash: ask\nempty:\n---\n# Body',
    );
    expect(frontmatter).toEqual({ name: 'coder', permission: { '*': 'allow', bash: 'ask' }, empty: '' });
    expect(body).toBe('# Body');
  });
  test('content without a block passes through', () => {
    expect(parseFrontmatter('# Title')).toEqual({ frontmatter: null, body: '# Title' });
  });
});

describe('languageFromPath', () => {
  test('extension aliases, known file names, and a text fallback', () => {
    expect(languageFromPath('/src/app.ts')).toBe('typescript');
    expect(languageFromPath('main.PY')).toBe('python');
    expect(languageFromPath('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('a.tsx')).toBe('tsx');
    expect(languageFromPath('notes.unknownext')).toBe('text');
    expect(languageFromPath('README')).toBe('text');
    expect(languageFromPath(undefined)).toBe('text');
  });
});

// A front-matter line used to lose its trailing whitespace through `/\s+$/`,
// which retried a whitespace run inside the line from every position in it:
// 60k spaces took 1.4 s on V8 (Bun's JSC runs it in linear time, so only the
// parity half of these tests can fail under Bun). `trimEnd` replaces it.
describe('parseFrontmatter trims each line in linear time', () => {
  test('trimEnd drops exactly what /\\s+$/ dropped, for every UTF-16 code unit', () => {
    for (let code = 0; code < 0x10000; code++) {
      const c = String.fromCharCode(code);
      const line = `a${c}${c}b${c}${c}`;
      expect(line.trimEnd()).toBe(line.replace(/\s+$/, ''));
    }
  });

  test('a front-matter line holding 240k spaces', () => {
    const started = performance.now();
    parseFrontmatter(`---\ntitle: a${' '.repeat(240_000)}b\n---\nbody`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
