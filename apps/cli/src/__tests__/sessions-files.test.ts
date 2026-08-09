import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type SessionFilesOps,
  buildPromptWithFiles,
  buildSpawnPrompt,
  joinDestPath,
  parseFileRef,
  sessionPromptDefaults,
  uploadTargetsFor,
  validateUploadSources,
  writeSessionFile,
} from '../commands/sessions-files.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('parseFileRef', () => {
  test('session-prefixed path is remote', () => {
    expect(parseFileRef('ses_abc123:/workspace/out/report.pdf')).toEqual({
      kind: 'remote',
      session: 'ses_abc123',
      path: '/workspace/out/report.pdf',
    });
  });

  test('remote path may be workspace-relative', () => {
    expect(parseFileRef('ses_abc123:out/report.pdf')).toEqual({
      kind: 'remote',
      session: 'ses_abc123',
      path: 'out/report.pdf',
    });
  });

  test('plain path is local', () => {
    expect(parseFileRef('./out/report.pdf')).toEqual({ kind: 'local', path: './out/report.pdf' });
    expect(parseFileRef('report.pdf')).toEqual({ kind: 'local', path: 'report.pdf' });
  });

  test('a colon after a slash does not make a ref remote', () => {
    expect(parseFileRef('dir/weird:name.txt')).toEqual({
      kind: 'local',
      path: 'dir/weird:name.txt',
    });
  });

  test('bare session ref with empty path targets the workspace root', () => {
    expect(parseFileRef('ses_abc123:')).toEqual({
      kind: 'remote',
      session: 'ses_abc123',
      path: '',
    });
  });
});

describe('joinDestPath', () => {
  test('keeps an explicit file destination', () => {
    expect(joinDestPath('/workspace/out/copy.bin', 'orig.bin', false)).toBe(
      '/workspace/out/copy.bin',
    );
  });

  test('appends the source name when the destination is a directory', () => {
    expect(joinDestPath('/workspace/out', 'orig.bin', true)).toBe('/workspace/out/orig.bin');
  });

  test('a trailing slash always means directory', () => {
    expect(joinDestPath('/workspace/out/', 'orig.bin', false)).toBe('/workspace/out/orig.bin');
  });
});

function mockFiles(overrides: Partial<SessionFilesOps> & { uploadedPath: string }): {
  ops: SessionFilesOps;
  calls: string[];
} {
  const calls: string[] = [];
  const ops: SessionFilesOps = {
    list: async () => [],
    readBlob: async () => new Blob(['x']),
    upload: async (_file, targetPath, filename) => {
      calls.push(`upload ${targetPath} ${filename}`);
      return [{ path: overrides.uploadedPath, size: 1 }];
    },
    remove: async (path) => {
      calls.push(`remove ${path}`);
      return true;
    },
    mkdir: async (dir) => {
      calls.push(`mkdir ${dir}`);
      return true;
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`);
      return true;
    },
    ...overrides,
  };
  return { ops, calls };
}

describe('uploadTargetsFor', () => {
  test('maps local paths to /workspace/incoming targets', () => {
    expect(uploadTargetsFor(['/tmp/report.pdf', './data/set.csv'])).toEqual([
      { local: '/tmp/report.pdf', target: '/workspace/incoming/report.pdf' },
      { local: './data/set.csv', target: '/workspace/incoming/set.csv' },
    ]);
  });

  test('rejects duplicate basenames', () => {
    expect(() => uploadTargetsFor(['/a/x.txt', '/b/x.txt'])).toThrow(/duplicate/i);
  });
});

describe('validateUploadSources', () => {
  test('accepts regular files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cli-upload-'));
    temporaryDirectories.push(dir);
    const file = join(dir, 'report.txt');
    await writeFile(file, 'report');
    await expect(
      validateUploadSources([{ local: file, target: '/workspace/incoming/report.txt' }]),
    ).resolves.toBeUndefined();
  });

  test('rejects directories before session provisioning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cli-upload-'));
    temporaryDirectories.push(dir);
    const nested = join(dir, 'folder');
    await mkdir(nested);
    await expect(
      validateUploadSources([{ local: nested, target: '/workspace/incoming/folder' }]),
    ).rejects.toThrow(/expects a file/);
  });
});

describe('buildPromptWithFiles', () => {
  test('appends a manifest of uploaded sandbox paths', () => {
    const text = buildPromptWithFiles('Summarize the report.', ['/workspace/incoming/report.pdf']);
    expect(text).toContain('Summarize the report.');
    expect(text).toContain('/workspace/incoming/report.pdf');
    expect(text).toMatch(/already in this sandbox/i);
  });

  test('returns the prompt unchanged with no files', () => {
    expect(buildPromptWithFiles('Hello', [])).toBe('Hello');
  });
});

describe('buildSpawnPrompt', () => {
  test('appends the session contract when spawning from inside a sandbox', () => {
    const text = buildSpawnPrompt('Generate a demo PDF.', { fromSandbox: true });
    expect(text).toContain('Generate a demo PDF.');
    expect(text).toMatch(/do the task .*yourself/i);
    expect(text).toMatch(/not spawn other sessions/i);
    expect(text).toContain('/workspace/out/');
    expect(text).toMatch(/uv run/);
  });

  test('leaves prompts from a human host untouched', () => {
    expect(buildSpawnPrompt('Generate a demo PDF.', { fromSandbox: false })).toBe(
      'Generate a demo PDF.',
    );
  });

  test('composes after the --with-file manifest', () => {
    const withFiles = buildPromptWithFiles('Summarize.', ['/workspace/incoming/a.pdf']);
    const text = buildSpawnPrompt(withFiles, { fromSandbox: true });
    expect(text.indexOf('/workspace/incoming/a.pdf')).toBeLessThan(
      text.indexOf('session contract'),
    );
  });
});

describe('sessionPromptDefaults', () => {
  test('resolves the persisted model and agent from the session row', () => {
    expect(
      sessionPromptDefaults({
        agent_name: 'kortix',
        metadata: { opencode_model: 'kortix/glm-5.2' },
      }),
    ).toEqual({ agent: 'kortix', model: { providerID: 'kortix', modelID: 'glm-5.2' } });
  });

  test('omits missing pieces instead of guessing', () => {
    expect(sessionPromptDefaults({ agent_name: null, metadata: {} })).toEqual({});
    expect(
      sessionPromptDefaults({ agent_name: 'agi', metadata: { opencode_model: 'nonsense' } }),
    ).toEqual({
      agent: 'agi',
    });
  });
});

describe('writeSessionFile', () => {
  test('uploads to a temporary path before replacing the target', async () => {
    const { ops, calls } = mockFiles({ uploadedPath: 'out/.data.bin.kortix-cp-uploaded' });
    const result = await writeSessionFile(ops, '/workspace/out/data.bin', new Blob(['hello']));
    expect(result.path).toBe('/workspace/out/data.bin');
    expect(calls[0]).toBe('mkdir /workspace/out');
    expect(calls[1]).toMatch(/^upload \/workspace\/out \.data\.bin\.kortix-cp-/);
    expect(calls[2]).toMatch(
      /^rename \/workspace\/out\/data\.bin \/workspace\/out\/data\.bin\.kortix-cp-backup-/,
    );
    expect(calls[3]).toBe(
      'rename /workspace/out/.data.bin.kortix-cp-uploaded /workspace/out/data.bin',
    );
    expect(calls[4]).toMatch(/^remove \/workspace\/out\/data\.bin\.kortix-cp-backup-/);
  });

  test('a missing target tolerates the replacement remove failing', async () => {
    const { ops, calls } = mockFiles({
      uploadedPath: '.fresh.txt.kortix-cp-uploaded',
      rename: async (from, to) => {
        calls.push(`rename ${from} ${to}`);
        if (from === '/workspace/fresh.txt') throw new Error('not found');
        return true;
      },
      remove: async (path) => {
        calls.push(`remove ${path}`);
        throw new Error('not found');
      },
    });
    const result = await writeSessionFile(ops, '/workspace/fresh.txt', new Blob(['hi']));
    expect(result.path).toBe('/workspace/fresh.txt');
    expect(calls.some((call) => call.startsWith('upload /workspace .fresh.txt.kortix-cp-'))).toBe(
      true,
    );
    expect(calls.some((call) => call.startsWith('rename /workspace/fresh.txt '))).toBe(true);
    expect(calls).toContain('rename /workspace/.fresh.txt.kortix-cp-uploaded /workspace/fresh.txt');
  });

  test('preserves the existing target when upload fails', async () => {
    const { ops, calls } = mockFiles({
      uploadedPath: '',
      upload: async () => {
        calls.push('upload-failed');
        throw new Error('network unavailable');
      },
    });
    await expect(writeSessionFile(ops, '/workspace/data.bin', new Blob(['new']))).rejects.toThrow(
      'network unavailable',
    );
    expect(calls).toEqual(['mkdir /workspace', 'upload-failed']);
  });

  test('restores the existing target when replacement rename fails', async () => {
    const { ops, calls } = mockFiles({
      uploadedPath: '.data.bin.kortix-cp-uploaded',
      rename: async (from, to) => {
        calls.push(`rename ${from} ${to}`);
        if (from === '/workspace/.data.bin.kortix-cp-uploaded') {
          throw new Error('rename unavailable');
        }
        return true;
      },
    });
    await expect(writeSessionFile(ops, '/workspace/data.bin', new Blob(['new']))).rejects.toThrow(
      'rename unavailable',
    );
    const backup = calls
      .find((call) => call.startsWith('rename /workspace/data.bin '))
      ?.split(' ')[2];
    expect(backup).toBeDefined();
    expect(calls).toContain(`rename ${backup} /workspace/data.bin`);
    expect(calls).toContain('remove /workspace/.data.bin.kortix-cp-uploaded');
  });
});
