import { describe, expect, test } from 'bun:test';

import { getStarterFiles, STARTER_TEMPLATE_IDS } from '../index';

const NATIVE_GUIDANCE_PATHS = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.pi/README.md'] as const;

describe('generic multi-harness starter', () => {
  test('keeps the old ACP template id as a compatibility alias', () => {
    expect(STARTER_TEMPLATE_IDS).toContain('acp-multi-harness');
  });

  test('ships four runtime profiles, four agents, and native guidance by default', () => {
    const files = getStarterFiles({
      projectName: 'Harness Lab',
      repoFullName: 'kortix/harness-lab',
      template: 'general-knowledge-worker',
    });
    const paths = files.map((file) => file.path);
    const manifest = files.find((file) => file.path === 'kortix.yaml')?.content ?? '';

    expect(manifest).toContain('kortix_version: 3');
    expect(manifest).toContain('default_agent: opencode');
    for (const harness of ['opencode', 'claude', 'codex', 'pi']) {
      expect(manifest).toContain(`harness: ${harness}`);
      expect(manifest).toContain(`  ${harness}:`);
      expect(manifest).toContain(`runtime: ${harness}`);
    }
    for (const path of NATIVE_GUIDANCE_PATHS) expect(paths).toContain(path);
    expect(paths).toContain('.kortix/opencode/skills/pdf/SKILL.md');
  });

  test('resolves the deprecated ACP template id to the generic starter files', () => {
    const generic = getStarterFiles({
      projectName: 'Harness Lab',
      repoFullName: 'kortix/harness-lab',
      template: 'general-knowledge-worker',
    });
    const compatibilityAlias = getStarterFiles({
      projectName: 'Harness Lab',
      repoFullName: 'kortix/harness-lab',
      template: 'acp-multi-harness',
    });

    expect(compatibilityAlias).toEqual(generic);
  });
});
