import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import embeddedStarter from '../embedded.generated.json' with { type: 'json' };

const managerPath = '.kortix/opencode/pty/opencode-pty/src/plugin/pty/manager.ts';
const toolsPath = '.kortix/opencode/pty/pty-tools.ts';
const templateManagerPath = join(import.meta.dir, '..', '..', 'templates', 'base', managerPath);
const templateToolsPath = join(import.meta.dir, '..', '..', 'templates', 'base', toolsPath);

function findEmbeddedFile(path: string): string {
  const base = (embeddedStarter as Record<string, { files: { path: string; content: string }[] }>).base;
  const file = base.files.find((item) => item.path === path);
  if (!file) throw new Error(`Missing embedded starter file: ${path}`);
  return file.content;
}

describe('starter PTY manager resilience', () => {
  test('falls back to local PTY when backend spawn or websocket attach fails', () => {
    const source = readFileSync(templateManagerPath, 'utf8');
    const embedded = findEmbeddedFile(managerPath);

    for (const content of [source, embedded]) {
      expect(content).toContain('function resolveBackendCommand');
      expect(content).toContain('command: resolveBackendCommand(opts.command, opts.env)');
      expect(content).toContain('private async spawnLocal');
      expect(content).toContain('markBackendUnavailable(err)');
      expect(content).toContain('spawn fell back to local PTY');
      expect(content).toContain('return this.spawnLocal(opts)');
    }
  });

  test('returns structured tool failures instead of throwing through OpenCode', () => {
    const source = readFileSync(templateToolsPath, 'utf8');
    const embedded = findEmbeddedFile(toolsPath);

    for (const content of [source, embedded]) {
      expect(content).toContain('async function recoverPtyTool');
      expect(content).toContain('<pty_failed>');
      expect(content).toContain("recoverPtyTool('pty-spawn'");
      expect(content).toContain("recoverPtyTool('pty-write'");
      expect(content).toContain("recoverPtyTool('pty-output'");
      expect(content).toContain("recoverPtyTool('pty-list'");
      expect(content).toContain("recoverPtyTool('pty-kill'");
    }
  });
});
