/**
 * `opencodeConfigDirChangedBetween` — the half of "is this session stale?" that
 * the compiled etag cannot see.
 *
 * A skill body, a tool, a plugin: none of them enter the compiled agent config,
 * so a merge that touched only those left `stale: false` on every running
 * session and the header never offered the reload. Real git repositories, for
 * the same reason as the daemon's config-dir tests: the property under test is
 * git's, not ours.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeConfigDirChangedBetween } from './opencode-config-dir';

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
  repo = mkdtempSync(join(tmpdir(), 'kortix-cfgdir-stale-'));
  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 'T');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('opencodeConfigDirChangedBetween', () => {
  test('a skill-only change is a change — the etag never sees it', async () => {
    const boot = commit(
      { '.kortix/opencode/opencode.jsonc': '{}', '.kortix/opencode/skills/a/SKILL.md': 'v1' },
      'boot',
    );
    const tip = commit({ '.kortix/opencode/skills/a/SKILL.md': 'v2' }, 'skill body');

    expect(await opencodeConfigDirChangedBetween(repo, project, boot, tip)).toBe(true);
  });

  test('a change outside the config dir is not', async () => {
    const boot = commit({ '.kortix/opencode/opencode.jsonc': '{}', 'app.ts': '1' }, 'boot');
    const tip = commit({ 'app.ts': '2' }, 'app');

    expect(await opencodeConfigDirChangedBetween(repo, project, boot, tip)).toBe(false);
  });

  test('the same commit is not stale', async () => {
    const boot = commit({ '.kortix/opencode/opencode.jsonc': '{}' }, 'boot');

    expect(await opencodeConfigDirChangedBetween(repo, project, boot, boot)).toBe(false);
  });

  test('a commit the mirror has never seen is unanswerable, NEVER false', async () => {
    // A session that committed without pushing reports a HEAD only it holds.
    const tip = commit({ '.kortix/opencode/opencode.jsonc': '{}' }, 'boot');

    expect(await opencodeConfigDirChangedBetween(repo, project, 'a'.repeat(40), tip)).toBeNull();
    expect(await opencodeConfigDirChangedBetween(repo, project, 'not-a-sha', tip)).toBeNull();
  });

  test('it follows the manifest when the config dir is not the default', async () => {
    const boot = commit(
      {
        'kortix.yaml': 'kortix_version: 2\nopencode:\n  config_dir: agent-config\n',
        'agent-config/opencode.jsonc': '{}',
        'agent-config/agents/a.md': 'v1',
      },
      'boot',
    );
    const tip = commit({ 'agent-config/agents/a.md': 'v2' }, 'agent');

    expect(await opencodeConfigDirChangedBetween(repo, project, boot, tip)).toBe(true);
  });

  test('a base with no project config has nothing to bring forward', async () => {
    const boot = commit({ 'app.ts': '1' }, 'boot');
    const tip = commit({ 'app.ts': '2' }, 'app');

    expect(await opencodeConfigDirChangedBetween(repo, project, boot, tip)).toBe(false);
  });
});
