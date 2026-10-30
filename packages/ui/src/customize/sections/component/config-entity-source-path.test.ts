import { describe, expect, test } from 'bun:test';

import { configEntitySourcePath } from './config-entity-source-path';

describe('configEntitySourcePath', () => {
  test('removes a manifest anchor from the file API path', () => {
    expect(configEntitySourcePath('kortix.yaml#agents.codex')).toBe('kortix.yaml');
  });

  test('keeps a normal source path unchanged', () => {
    expect(configEntitySourcePath('.codex/AGENTS.md')).toBe('.codex/AGENTS.md');
  });
});
