import { describe, expect, test } from 'bun:test';

import { HARNESSES, HARNESS_IDS, isHarnessId } from './harnesses';

describe('canonical harness descriptor', () => {
  test('defines the complete stable presentation order', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(Object.keys(HARNESSES).sort()).toEqual([...HARNESS_IDS].sort());
  });

  test('owns labels and native config directories', () => {
    expect(HARNESSES).toMatchObject({
      claude: { label: 'Claude Code', configDir: '.claude' },
      codex: { label: 'Codex', configDir: '.codex' },
      opencode: { label: 'OpenCode', configDir: '.kortix/opencode' },
      pi: { label: 'Pi', configDir: '.pi' },
    });
  });

  test('parses only canonical harness identifiers', () => {
    expect(isHarnessId('codex')).toBe(true);
    expect(isHarnessId('custom')).toBe(false);
    expect(isHarnessId(null)).toBe(false);
  });
});
