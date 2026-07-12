import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
});
