import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readComposedRelease, resolveReleaseTreeSource, selectedOpenCodePlugins, configArchiveRoute } from './builder';
import { serveConfigArchive } from './serve-archive';
import { MemoryConfigArchiveStore } from './__tests__/fakes';

describe('OpenCode plugin selection', () => {
  test('global plus agent opt-in/out; legacy remains auto-discovered', () => {
    const raw = { kortix_version: 2, harnesses: { opencode: { plugins: ['base.ts', 'other.js'] } }, agents: { a: { harnesses: { opencode: { exclude: ['base.ts'], plugins: ['extra.ts'] } } }, b: {} } };
    expect(selectedOpenCodePlugins(raw, 'a')).toEqual(['other.js', 'extra.ts']);
    expect(selectedOpenCodePlugins(raw, 'b')).toEqual(['base.ts', 'other.js']);
    expect(selectedOpenCodePlugins(raw, 'missing')).toBeNull();
    expect(selectedOpenCodePlugins({ kortix_version: 1 }, 'a')).toBeNull();
  });
  test('the selected release omits other plugin entrypoints, but keeps their imported modules', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-plugins-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(repo, 'harnesses/opencode/plugins/lib'), { recursive: true });
      writeFileSync(join(repo, 'harnesses/opencode/opencode.jsonc'), '{}');
      writeFileSync(join(repo, 'harnesses/opencode/plugins/base.ts'), 'export {}');
      writeFileSync(join(repo, 'harnesses/opencode/plugins/other.ts'), 'export {}');
      writeFileSync(join(repo, 'harnesses/opencode/plugins/lib/helper.ts'), 'export {}');
      writeFileSync(join(repo, 'kortix.yaml'), 'kortix_version: 2\ndefault_agent: a\nharnesses:\n  opencode:\n    plugins: [base.ts]\nagents:\n  a: {}\n  b:\n    harnesses:\n      opencode:\n        exclude: [base.ts]\n        plugins: [other.ts]\n');
      git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      const project = { manifestPath: 'kortix.yaml' };
      const commit = git('rev-parse', 'HEAD');
      const a = await resolveReleaseTreeSource(repo, project, commit, 'agent:a');
      const b = await resolveReleaseTreeSource(repo, project, commit, 'agent:b');
      if (!('source' in a) || !('source' in b)) throw new Error('missing source');
      const files = async (source: typeof a.source) => (await readComposedRelease(repo, source, { archive: false })).files.map(([path]) => path);
      expect(await files(a.source)).toContain('harnesses/opencode/plugins/base.ts');
      expect(await files(a.source)).not.toContain('harnesses/opencode/plugins/other.ts');
      expect(await files(b.source)).toContain('harnesses/opencode/plugins/other.ts');
      expect(await files(b.source)).not.toContain('harnesses/opencode/plugins/base.ts');
      expect(await files(b.source)).toContain('harnesses/opencode/plugins/lib/helper.ts');
      const archive = await readComposedRelease(repo, b.source, { archive: false });
      const url = new URL(configArchiveRoute('00000000-0000-4000-8000-000000000001', archive.treeId, commit, 'agent:b'), 'http://localhost');
      expect(url.searchParams.get('agent')).toBe('b');
      const response = await serveConfigArchive({ ...project, projectId: '00000000-0000-4000-8000-000000000001' } as Parameters<typeof serveConfigArchive>[0], archive.treeId, async () => repo, async () => repo, { store: new MemoryConfigArchiveStore(), publicOverride: null }, commit, url.searchParams.get('agent'));
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array((await readComposedRelease(repo, b.source, { archive: true })).archive!));
      expect((await resolveReleaseTreeSource(repo, project, commit, 'agent:a'))).toHaveProperty('source');
      expect(await resolveReleaseTreeSource(repo, project, commit, 'project')).toHaveProperty('source');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  test('a per-agent release selects its plugins and keeps every other file at its repository path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-plugins-pi-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(repo, 'harnesses/opencode/plugins'), { recursive: true });
      mkdirSync(join(repo, 'harnesses/pi/extensions'), { recursive: true });
      writeFileSync(join(repo, 'harnesses/opencode/opencode.jsonc'), '{}');
      writeFileSync(join(repo, 'harnesses/opencode/plugins/base.ts'), 'export {}');
      writeFileSync(join(repo, 'harnesses/opencode/plugins/other.ts'), 'export {}');
      writeFileSync(join(repo, 'harnesses/pi/extensions/guard.ts'), 'export default () => {}');
      writeFileSync(join(repo, 'kortix.yaml'), 'kortix_version: 2\ndefault_agent: a\nharnesses:\n  opencode:\n    plugins: [base.ts]\nagents:\n  a: {}\n');
      git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      const project = { manifestPath: 'kortix.yaml', projectId: '00000000-0000-4000-8000-000000000001' };
      const commit = git('rev-parse', 'HEAD');
      const a = await resolveReleaseTreeSource(repo, project, commit, 'agent:a');
      if (!('source' in a)) throw new Error('missing source');
      const release = await readComposedRelease(repo, a.source, { archive: false });
      expect(release.files.map(([path]) => path)).toEqual(['harnesses/opencode/opencode.jsonc', 'harnesses/opencode/plugins/base.ts', 'harnesses/pi/extensions/guard.ts', 'kortix.yaml']);
      // The archive route rebuilds the same tree from the commit and the agent.
      const response = await serveConfigArchive(project as Parameters<typeof serveConfigArchive>[0], release.treeId, async () => repo, async () => repo, { store: new MemoryConfigArchiveStore(), publicOverride: null }, commit, 'a');
      expect(response.status).toBe(200);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
