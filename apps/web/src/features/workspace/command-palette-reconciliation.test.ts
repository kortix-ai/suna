import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const palette = readFileSync(
  fileURLToPath(new URL('./command-palette.tsx', import.meta.url)),
  'utf8',
);
const registry = readFileSync(
  fileURLToPath(new URL('../../lib/menu-registry.ts', import.meta.url)),
  'utf8',
);

describe('command palette Git reconciliation', () => {
  test('asks the mounted agent instead of mutating the workspace through full reload', () => {
    expect(palette).toContain('buildAgentGitReconciliationPrompt');
    expect(palette).toContain('sendToSession(');
    expect(palette).toContain('currentSessionId,');
    expect(palette).not.toContain("systemReload('full')");
  });

  test('labels the action as agent work and makes conflict terms searchable', () => {
    const item = registry.slice(
      registry.indexOf("id: 'sync-session-branch'"),
      registry.indexOf("id: 'sync-session-branch'") + 700,
    );
    expect(item).toContain('Ask Agent: Sync Branch & Reload');
    expect(item).toContain('conflict');
    expect(item).toContain('reconcile');
  });
});
