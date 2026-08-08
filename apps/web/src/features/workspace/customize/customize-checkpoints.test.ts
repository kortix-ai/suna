import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';
import { railGroups } from './rail';

// The rail lives in rail.ts and the panel that renders it in customize-panel.tsx;
// read both so a checkpoint holds wherever a section is declared.
const customizeSource = ['rail.ts', 'customize-panel.tsx']
  .map((f) => readFileSync(join(import.meta.dir, f), 'utf8'))
  .join('\n');

describe('Customize information architecture', () => {
  test('Git and Sandbox templates live in Manage without a Workspace group', () => {
    expect(customizeSource).not.toContain("label: 'Workspace'");
    expect(customizeSource).toContain("section: 'git', label: 'Git'");
    expect(customizeSource).toContain("section: 'sandbox', label: 'Sandbox templates'");
    expect(customizeSource).not.toContain("section: 'changes'");
    expect(customizeSource).not.toContain("section: 'dev'");

    const git = menuRegistry.find((item) => item.id === 'proj-git');
    expect(git?.label).toBe('Customize · Git');
    expect(menuRegistry.find((item) => item.id === 'proj-sandbox')?.label).toBe(
      'Customize · Sandbox templates',
    );
    expect(menuRegistry.find((item) => item.id === 'proj-changes')).toBeUndefined();
  });

  test('Files is not a customize rail section — it lives on the standalone files page', () => {
    expect(customizeSource).not.toContain("section: 'files'");
    const entry = menuRegistry.find((item) => item.id === 'proj-files');
    expect(entry?.label).toBe('Files');
    expect(entry?.href).toBe('/projects/{projectId}/files');
  });

  test('LLM management remains reachable from the Connect rail group', () => {
    const connect = railGroups({
      tunnelEnabled: false,
      marketplaceEnabled: false,
      llmGatewayEnabled: true,
      voiceEnabled: false,
      reviewEnabled: false,
    }).find((g) => g.label === 'Connect');
    expect(connect?.items.some((i) => i.section === 'llm-management')).toBe(true);
  });
});
