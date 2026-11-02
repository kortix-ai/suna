/**
 * `loadedFilesChangedBetween` — the half of "is this session stale?" that the
 * compiled etag cannot see.
 *
 * A skill body, a tool module, an extension module: none of them enter the
 * compiled agent config, so a merge that touched only those left `stale: false`
 * on every running session and the header never offered the reload. Real git
 * repositories: the property under test is git's, not ours.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadedFilesChangedBetween, readManifestAtSha } from './loaded-files';

let repo: string;
const project = { manifestPath: 'kortix.yaml' };

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(files: Record<string, string>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kortix-loaded-files-'));
  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 'T');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const MANIFEST = [
  'default_agent: a',
  'skills:',
  '  s: skills/s',
  'tools:',
  '  lookup: tools/lookup/index.ts',
  'extensions:',
  '  audit:',
  '    pi: extensions/audit',
  '  web:',
  '    pi: npm:pi-web-access@0.30.0',
  'agents:',
  '  a:',
  '    prompt_file: agents/a.md',
  '',
].join('\n');

describe('loadedFilesChangedBetween', () => {
  test('a change to a registered skill, tool or extension folder is a change', async () => {
    const boot = commit(
      {
        'kortix.yaml': MANIFEST,
        'skills/s/SKILL.md': 'v1',
        'tools/lookup/index.ts': 'v1',
        'tools/lookup/lib.ts': 'v1',
        'extensions/audit/index.ts': 'v1',
        'agents/a.md': 'p',
      },
      'boot',
    );
    const skill = commit({ 'skills/s/SKILL.md': 'v2' }, 'skill body');
    expect(await loadedFilesChangedBetween(repo, project, boot, skill)).toBe(true);
    // A tool module imports its siblings: the whole folder counts.
    const sibling = commit({ 'tools/lookup/lib.ts': 'v2' }, 'tool sibling');
    expect(await loadedFilesChangedBetween(repo, project, skill, sibling)).toBe(true);
    const extension = commit({ 'extensions/audit/index.ts': 'v2' }, 'extension');
    expect(await loadedFilesChangedBetween(repo, project, sibling, extension)).toBe(true);
  });

  test('a change outside every registered path is not, and neither is a retired harness folder', async () => {
    const boot = commit({ 'kortix.yaml': MANIFEST, 'skills/s/SKILL.md': 'v1', 'agents/a.md': 'p' }, 'boot');
    const tip = commit(
      { 'docs/readme.md': 'x', 'harnesses/opencode/opencode.jsonc': '{}', '.kortix/opencode/skills/old/SKILL.md': 'x' },
      'docs and leftovers',
    );
    expect(await loadedFilesChangedBetween(repo, project, boot, tip)).toBe(false);
  });

  test('the same commit is not stale', async () => {
    const boot = commit({ 'kortix.yaml': MANIFEST }, 'boot');
    expect(await loadedFilesChangedBetween(repo, project, boot, boot)).toBe(false);
  });

  test('a commit the mirror has never seen is unanswerable, NEVER false', async () => {
    // A session that committed without pushing reports a HEAD only it holds.
    const tip = commit({ 'kortix.yaml': MANIFEST }, 'boot');
    expect(await loadedFilesChangedBetween(repo, project, 'a'.repeat(40), tip)).toBeNull();
    expect(await loadedFilesChangedBetween(repo, project, 'not-a-sha', tip)).toBeNull();
  });

  test('a base with no manifest has nothing to bring forward', async () => {
    const boot = commit({ 'app.ts': '1' }, 'boot');
    const tip = commit({ 'app.ts': '2' }, 'app');
    expect(await loadedFilesChangedBetween(repo, project, boot, tip)).toBe(false);
  });
});

describe('readManifestAtSha', () => {
  test('reads kortix.yaml, else kortix.yml; never a retired kortix.toml', async () => {
    const yml = commit({ 'kortix.yml': 'default_agent: a\n', 'kortix.toml': 'default_agent = "b"\n' }, 'yml');
    expect(await readManifestAtSha(repo, project, yml)).toEqual({ default_agent: 'a' });
    git('rm', '-q', 'kortix.yml');
    const tomlOnly = commit({}, 'toml only');
    expect(await readManifestAtSha(repo, project, tomlOnly)).toBeNull();
  });
});
