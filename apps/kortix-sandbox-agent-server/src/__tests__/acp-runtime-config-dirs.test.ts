import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

import { ensureHarnessConfigDirs } from '../acp/runtime';

describe('ACP runtime config directories', () => {
  test('creates harness-native config directories before spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-acp-config-'));
    try {
      ensureHarnessConfigDirs({
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        CODEX_HOME: join(root, 'codex'),
        OPENCODE_CONFIG_DIR: '.kortix/opencode',
        PI_CODING_AGENT_DIR: '',
      }, root);

      expect(existsSync(join(root, 'claude'))).toBe(true);
      expect(existsSync(join(root, 'codex'))).toBe(true);
      expect(existsSync(join(root, '.kortix/opencode'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('seeds the managed Pi gateway model without overwriting native config', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-acp-pi-'));
    const dir = join(root, '.pi');
    try {
      ensureHarnessConfigDirs({ PI_CODING_AGENT_DIR: dir, KORTIX_PI_MODELS_JSON: '{"managed":true}' }, root);
      expect(readFileSync(join(dir, 'models.json'), 'utf8')).toContain('"managed":true');
      writeFileSync(join(dir, 'models.json'), '{"native":true}\n');
      ensureHarnessConfigDirs({ PI_CODING_AGENT_DIR: dir, KORTIX_PI_MODELS_JSON: '{"managed":true}' }, root);
      expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe('{"native":true}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
