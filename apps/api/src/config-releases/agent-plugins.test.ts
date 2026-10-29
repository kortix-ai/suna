import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readComposedRelease, resolveReleaseTreeSource, selectedOpenCodePlugins } from './builder';

describe('OpenCode plugin selection', () => {
  test('a kortix_version 3 release has no OpenCode config dir and no plugin variant', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-plugins-v3-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(repo, 'harnesses/opencode/plugins'), { recursive: true });
      mkdirSync(join(repo, '.kortix/opencode'), { recursive: true });
      mkdirSync(join(repo, 'agents'), { recursive: true });
      // Leftovers of a v2 layout: a v3 session never reads them.
      writeFileSync(join(repo, 'harnesses/opencode/opencode.jsonc'), '{}');
      writeFileSync(join(repo, '.kortix/opencode/opencode.json'), '{}');
      // A v3 extension may keep its module where the v2 plugin was.
      writeFileSync(join(repo, 'harnesses/opencode/plugins/audit.ts'), 'export {}');
      writeFileSync(join(repo, 'agents/a.md'), 'You are a.');
      writeFileSync(join(repo, 'kortix.yaml'), 'kortix_version: 3\ndefault_agent: a\nextensions:\n  audit:\n    opencode: harnesses/opencode/plugins/audit.ts\nagents:\n  a:\n    mode: primary\n    prompt_file: agents/a.md\n    extensions: [audit]\n');
      git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      const project = { manifestPath: 'kortix.yaml' };
      const commit = git('rev-parse', 'HEAD');

      for (const variant of ['project', 'agent:a'] as const) {
        const resolved = await resolveReleaseTreeSource(repo, project, commit, variant);
        if (!('source' in resolved)) throw new Error('missing source');
        expect(resolved.source.configDir).toBeNull();
        expect(resolved.source.plugins).toBeNull();
        const files = (await readComposedRelease(repo, resolved.source, { archive: false })).files.map(([path]) => path);
        expect(files).not.toContain('harnesses/opencode/opencode.jsonc');
        expect(files).not.toContain('.kortix/opencode/opencode.json');
        expect(files).toContain('harnesses/opencode/plugins/audit.ts');
        expect(files).toContain('agents/a.md');
        expect(files).toContain('kortix.yaml');
      }
      expect(selectedOpenCodePlugins({ kortix_version: 3, agents: { a: {} } }, 'a')).toBeNull();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
