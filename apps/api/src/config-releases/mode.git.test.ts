/**
 * Config mode against real Git repositories (spec, "Config mode").
 *
 * The repository is a bare remote the API mirrors. A second clone plays the
 * session box: it writes files, commits, and pushes when a test needs the
 * session branch in the mirror. The workspace report is built the way the
 * daemon builds it: path, status, and the working-tree blob ID.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateProjectMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import type { ConfigRelease } from './builder';
import {
  __clearConfigModeCachesForTests,
  explainConfigMode,
  gitBlobId,
  packageJsonWithoutPluginPin,
  type WorkspaceReport,
} from './mode';

const CONFIG_DIR = '.kortix/opencode';
const AGENT = `${CONFIG_DIR}/agents/kortix.md`;
const PKG = `${CONFIG_DIR}/package.json`;
const LOCK = `${CONFIG_DIR}/bun.lock`;
const MANAGED = `${CONFIG_DIR}/skills/kortix-cli/SKILL.md`;
const OWN_SKILL = `${CONFIG_DIR}/skills/my-skill/SKILL.md`;
const MANAGED_SKILLS = new Set(['kortix-cli', 'kortix-system']);

const pkg = (pin: string, extra = '') => `{\n  "dependencies": {\n    "@opencode-ai/plugin": "${pin}"${extra}\n  }\n}\n`;

let root = '';
let remote = '';
let base = '';
let box = '';
let project: GitBackedProject;
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;

function run(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
}

/** Commit on the base branch and push it. Returns the new tip. */
function baseCommit(files: Record<string, string>, message: string, remove: string[] = []): string {
  write(base, files);
  for (const path of remove) run(base, 'rm', '-q', path);
  run(base, 'add', '-A');
  run(base, 'commit', '-qm', message);
  run(base, 'push', '-q', 'origin', 'main');
  invalidateProjectMirror(project.projectId);
  return run(base, 'rev-parse', 'HEAD');
}

function tip(): string {
  return run(base, 'rev-parse', 'HEAD');
}

function change(path: string, status: 'modified' | 'added' | 'deleted' | 'untracked', body: string | null) {
  return { path, status, blob: body === null ? null : gitBlobId(body) };
}

function report(changed: WorkspaceReport['changed'], extra: Partial<WorkspaceReport> = {}): WorkspaceReport {
  return { head: run(box, 'rev-parse', 'HEAD'), config_dir: CONFIG_DIR, changed, ...extra };
}

async function decide(workspace: WorkspaceReport | null, maxHistoryLookups?: number) {
  return explainConfigMode({
    project,
    baseSha: tip(),
    release: {} as ConfigRelease,
    report: workspace,
    managedSkills: MANAGED_SKILLS,
    maxHistoryLookups,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-config-mode-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
});

afterAll(() => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  __clearConfigModeCachesForTests();
  const id = crypto.randomUUID();
  remote = join(root, `remote-${id}.git`);
  base = join(root, `base-${id}`);
  box = join(root, `box-${id}`);
  run(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  run(root, 'init', '-q', '--initial-branch=main', base);
  for (const repo of [base]) {
    run(repo, 'config', 'user.email', 't@kortix.invalid');
    run(repo, 'config', 'user.name', 'T');
  }
  run(base, 'remote', 'add', 'origin', remote);
  project = { projectId: id, repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'local-test' };

  baseCommit({ 'app.ts': 'export const x = 1\n' }, 'root');
  baseCommit(
    {
      [`${CONFIG_DIR}/opencode.jsonc`]: '{}\n',
      [AGENT]: 'ORIGINAL PROMPT\n',
      [PKG]: pkg('1.17.11'),
      [LOCK]: '"@opencode-ai/plugin": "1.17.11"\n',
      [MANAGED]: 'REPO COPY OF KORTIX-CLI\n',
      [OWN_SKILL]: 'MY SKILL v1\n',
    },
    'config',
  );
  run(root, 'clone', '-q', remote, box);
  run(box, 'config', 'user.email', 't@kortix.invalid');
  run(box, 'config', 'user.name', 'T');
  run(box, 'checkout', '-q', '-b', 'ses-1111');
  // Base moves on after the session branched.
  baseCommit({ [AGENT]: 'UPDATED PROMPT\n' }, 'update agent');
});

/** What a real boot wrote into an untouched session (dev, 2026-09-18, session 6d8dfdae). */
const platformDirt = () => [
  change(PKG, 'modified', pkg('1.18.23')),
  change(LOCK, 'modified', '"@opencode-ai/plugin": "1.18.23"\n'),
  change(MANAGED, 'modified', 'OVERLAY KORTIX-CLI\n'),
];

describe('decideConfigMode with real Git history', () => {
  test('no report and an empty report follow the base branch', async () => {
    expect((await decide(null)).mode).toBe('follow-base');
    expect((await decide(report([]))).mode).toBe('follow-base');
  });

  test('an untouched session with platform dirt follows the base branch', async () => {
    const decision = await decide(report(platformDirt(), { package_json: pkg('1.18.23') }));
    expect(decision).toEqual({ mode: 'follow-base', sessionPath: null });
  });

  test('pin dirt the agent committed and pushed is read from the mirror without package_json', async () => {
    write(box, { [PKG]: pkg('1.18.23'), [LOCK]: '"@opencode-ai/plugin": "1.18.23"\n' });
    run(box, 'add', '-A');
    run(box, 'commit', '-qm', 'agent: git add -A');
    run(box, 'push', '-q', 'origin', 'ses-1111');
    invalidateProjectMirror(project.projectId);
    const decision = await decide(report(platformDirt()));
    expect(decision.mode).toBe('follow-base');
  });

  test('uncommitted pin dirt without package_json counts as session work: the API cannot read it', async () => {
    const decision = await decide(report(platformDirt()));
    expect(decision).toEqual({ mode: 'session-files', sessionPath: PKG });
  });

  test('a package_json whose blob does not match the report is ignored', async () => {
    const decision = await decide(report(platformDirt(), { package_json: pkg('9.9.9') }));
    expect(decision.mode).toBe('session-files');
  });

  test('an added section with only the pin is platform output', async () => {
    const onlyPin = '{\n  "devDependencies": {\n    "@opencode-ai/plugin": "1.18.23"\n  },\n  "dependencies": {\n    "@opencode-ai/plugin": "1.18.23"\n  }\n}\n';
    const decision = await decide(report([change(PKG, 'modified', onlyPin)], { package_json: onlyPin }));
    expect(decision.mode).toBe('follow-base');
  });

  test('an added dependency is session work, and so is its lockfile', async () => {
    const text = pkg('1.18.23', ',\n    "left-pad": "1.3.0"');
    const decision = await decide(
      report([change(PKG, 'modified', text), change(LOCK, 'modified', 'left-pad\n')], { package_json: text }),
    );
    expect(decision.mode).toBe('session-files');
  });

  test("an agent's `git add -A` of old synced bytes follows the base branch", async () => {
    // A pre-refactor daemon checked base's config out into the session tree;
    // the agent then committed it. Base has since moved again.
    run(box, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    run(box, 'checkout', 'refs/remotes/origin/main', '--', CONFIG_DIR);
    run(box, 'add', '-A');
    run(box, 'commit', '-qm', 'agent: git add -A over the old sync');
    baseCommit({ [AGENT]: 'THIRD PROMPT\n' }, 'third');
    const decision = await decide(report([change(AGENT, 'modified', 'UPDATED PROMPT\n'), ...platformDirt()], { package_json: pkg('1.18.23') }));
    expect(decision.mode).toBe('follow-base');
  });

  test('a real edit to an agent is session work', async () => {
    const decision = await decide(report([change(AGENT, 'modified', 'MY WORK IN PROGRESS\n')]));
    expect(decision).toEqual({ mode: 'session-files', sessionPath: AGENT });
  });

  test('a new skill is session work', async () => {
    const decision = await decide(report([change(`${CONFIG_DIR}/skills/brand-new/SKILL.md`, 'untracked', 'draft\n')]));
    expect(decision.mode).toBe('session-files');
  });

  test('an edit inside a managed skill is platform output; a skill that only looks managed is not', async () => {
    expect((await decide(report([change(`${CONFIG_DIR}/skills/kortix-system/SKILL.md`, 'modified', 'x\n')]))).mode).toBe(
      'follow-base',
    );
    expect((await decide(report([change(`${CONFIG_DIR}/skills/kortix-cli-mine/SKILL.md`, 'untracked', 'x\n')]))).mode).toBe(
      'session-files',
    );
  });

  test('a deleted file that base still has is session work', async () => {
    // OWN_SKILL was added after the root commit. Its pre-add absence must not
    // count as a base revision.
    const decision = await decide(report([change(OWN_SKILL, 'deleted', null)]));
    expect(decision).toEqual({ mode: 'session-files', sessionPath: OWN_SKILL });
  });

  test('a file base itself deleted follows the base branch when the session deletes it too', async () => {
    baseCommit({}, 'retire my-skill', [OWN_SKILL]);
    expect((await decide(report([change(OWN_SKILL, 'deleted', null)]))).mode).toBe('follow-base');
  });

  test('a reverted edit follows the base branch', async () => {
    // The session edited, then reverted to the base tip's bytes.
    expect((await decide(report([change(AGENT, 'modified', 'UPDATED PROMPT\n')]))).mode).toBe('follow-base');
    // Or to the bytes it branched from: still a base revision.
    expect((await decide(report([change(AGENT, 'modified', 'ORIGINAL PROMPT\n')]))).mode).toBe('follow-base');
  });

  test('a merged session edit follows the base branch again', async () => {
    const decision0 = await decide(report([change(AGENT, 'modified', 'MERGED EDIT\n')]));
    expect(decision0.mode).toBe('session-files');
    baseCommit({ [AGENT]: 'MERGED EDIT\n' }, 'merge the session edit');
    expect((await decide(report([change(AGENT, 'modified', 'MERGED EDIT\n')]))).mode).toBe('follow-base');
  });

  test('paths outside the config dir are not config work', async () => {
    expect((await decide(report([change('src/feature.ts', 'untracked', 'x\n')]))).mode).toBe('follow-base');
  });

  test('a report beyond the history lookup cap counts as session work', async () => {
    const changed = [1, 2, 3].map((n) => change(`${CONFIG_DIR}/agents/a${n}.md`, 'deleted', null));
    expect((await decide(report(changed), 2)).mode).toBe('session-files');
  });
});

describe('packageJsonWithoutPluginPin', () => {
  test('ignores key order and whitespace, keeps every other dependency', () => {
    const a = '{"dependencies":{"a":"1","@opencode-ai/plugin":"1"},"name":"x"}';
    const b = '{\n  "name": "x",\n  "dependencies": { "@opencode-ai/plugin": "2", "a": "1" }\n}';
    expect(packageJsonWithoutPluginPin(a)).toBe(packageJsonWithoutPluginPin(b));
    expect(packageJsonWithoutPluginPin('{"dependencies":{"a":"2"}}')).not.toBe(packageJsonWithoutPluginPin(a));
  });

  test('unparseable text and non-objects are null', () => {
    expect(packageJsonWithoutPluginPin('{')).toBeNull();
    expect(packageJsonWithoutPluginPin('[]')).toBeNull();
    expect(packageJsonWithoutPluginPin(null)).toBeNull();
  });
});
