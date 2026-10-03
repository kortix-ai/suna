import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exitCodeFromCloseReason } from '../pty-attach.ts';
import { agentAuthFor, buildBootstrap, parseRunArgv, pullSessionChanges, snapshotWorkingTree } from './run.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kortix-run-test-'));
  dirs.push(d);
  return d;
};
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  process.env = { ...savedEnv };
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

describe('parseRunArgv', () => {
  test('kortix flags before the command, everything after belongs to it', () => {
    expect(parseRunArgv(['--session', 's1', '--', 'claude', '--project', 'x'])).toEqual({
      sessionArg: 's1',
      command: ['claude', '--project', 'x'],
    });
    expect(parseRunArgv(['--project=p', 'codex', '--help'])).toEqual({ projectArg: 'p', command: ['codex', '--help'] });
    expect(parseRunArgv([])).toEqual({ command: [] });
    expect(parseRunArgv(['--help'])).toBe('help');
    expect(parseRunArgv(['--bogus'])).toContain('Unknown option');
    expect(parseRunArgv(['--session'])).toContain('needs a value');
  });
});

describe('exitCodeFromCloseReason', () => {
  test('reads the daemon close reason', () => {
    expect(exitCodeFromCloseReason('pty exited (7)')).toBe(7);
    expect(exitCodeFromCloseReason('pty exited')).toBeNull();
    expect(exitCodeFromCloseReason('idle timeout')).toBeNull();
  });
});

describe('snapshotWorkingTree', () => {
  test('captures tracked edits and untracked files without touching the index or branch', () => {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'dev@example.com');
    git(repo, 'config', 'user.name', 'Dev');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const head = git(repo, 'rev-parse', 'HEAD');
    process.chdir(repo);

    expect(snapshotWorkingTree()).toEqual({ sha: head, dirty: false });

    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    writeFileSync(join(repo, 'ignored.txt'), 'secret\n');
    const statusBefore = git(repo, 'status', '--porcelain');
    const snap = snapshotWorkingTree();
    if ('error' in snap) throw new Error(snap.error);
    expect(snap.dirty).toBe(true);
    expect(git(repo, 'show', `${snap.sha}:a.txt`)).toBe('two');
    expect(git(repo, 'show', `${snap.sha}:new.txt`)).toBe('untracked');
    expect(git(repo, 'ls-tree', '--name-only', snap.sha)).not.toContain('ignored.txt');
    expect(git(repo, 'rev-parse', `${snap.sha}^`)).toBe(head);
    // The user's repo is exactly as it was.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  });

  test('refuses outside a git repository', () => {
    process.chdir(tmp());
    expect(snapshotWorkingTree()).toEqual({ error: 'Not inside a git repository.' });
  });
});

describe('agentAuthFor', () => {
  test('claude prefers a long-lived token from the environment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-long-lived';
    const auth = agentAuthFor('claude');
    expect(auth.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-long-lived' });
    expect(auth.files.filter((f) => f.secret)).toEqual([]);
  });

  test('claude forwards the local access token, never the refresh token', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const dir = tmp();
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 5 * 3600_000 },
        mcpOAuth: { server: { accessToken: 'mcp' } },
      }),
    );
    const creds = agentAuthFor('claude').files.find((f) => f.path.endsWith('.credentials.json'))!;
    const sent = JSON.parse(creds.content);
    expect(creds.secret).toBe(true);
    expect(sent.claudeAiOauth.accessToken).toBe('acc');
    expect(sent.claudeAiOauth.refreshToken).toBeUndefined();
    expect(sent.mcpOAuth).toBeUndefined();
  });

  test('claude reports an expired local login instead of sending it', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const dir = tmp();
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() - 1000 } }),
    );
    const auth = agentAuthFor('claude');
    expect(auth.files.some((f) => f.secret)).toBe(false);
    expect(auth.notes.join(' ')).toContain('expired');
  });

  test('codex forwards auth.json with the refresh token blanked', () => {
    const dir = tmp();
    process.env.CODEX_HOME = dir;
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' }, last_refresh: '2020-01-01T00:00:00Z' }),
    );
    const creds = agentAuthFor('codex').files.find((f) => f.path.endsWith('auth.json'))!;
    const sent = JSON.parse(creds.content);
    expect(sent.tokens.access_token).toBe('a');
    expect(sent.tokens.refresh_token).toBe('');
    expect(Date.parse(sent.last_refresh)).toBeGreaterThan(Date.now() - 60_000);
  });

  test('other commands carry no credentials', () => {
    expect(agentAuthFor('pnpm')).toEqual({ files: [], env: {}, notes: [] });
  });
});

describe('buildBootstrap', () => {
  // Runs the generated script in a real bash, the way the PTY does, with HOME
  // pointed at a scratch dir and the go byte on stdin.
  const runScript = (script: string, env: Record<string, string>, home: string, command: string[]) =>
    spawnSync('bash', ['-c', script, 'kortix-run', ...command], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      input: 'x',
      encoding: 'utf8',
    });

  test('writes files, runs the command, deletes secrets, keeps the exit code', () => {
    const home = tmp();
    const boot = buildBootstrap({
      files: [
        { path: '$HOME/.agent/creds.json', content: '{"token":"t"}', secret: true },
        { path: '$HOME/.agent.json', content: '{"onboarded":true}', secret: false, keepExisting: true },
      ],
    });
    expect(boot.script).not.toContain('"token"');
    const r = runScript(boot.script, boot.env, home, [
      'bash',
      '-c',
      'cat "$HOME/.agent/creds.json"; env | grep -c KORTIX_RUN_FILE; exit 7',
    ]);
    expect(r.status).toBe(7);
    expect(r.stdout).toContain('{"token":"t"}');
    expect(r.stdout.trim().endsWith('0')).toBe(true);
    expect(existsSync(join(home, '.agent/creds.json'))).toBe(false);
    expect(readFileSync(join(home, '.agent.json'), 'utf8')).toBe('{"onboarded":true}');
  });

  test('keepExisting leaves a file the agent already maintains', () => {
    const home = tmp();
    writeFileSync(join(home, '.agent.json'), 'mine');
    const boot = buildBootstrap({ files: [{ path: '$HOME/.agent.json', content: 'new', secret: false, keepExisting: true }] });
    expect(runScript(boot.script, boot.env, home, ['true']).status).toBe(0);
    expect(readFileSync(join(home, '.agent.json'), 'utf8')).toBe('mine');
  });
});

describe('pullSessionChanges', () => {
  // A bare repo stands in for the project repo; a second clone plays the sandbox.
  const setup = () => {
    const remote = tmp();
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    const local = tmp();
    git(local, 'init', '-q', '-b', 'main');
    git(local, 'config', 'user.email', 'dev@example.com');
    git(local, 'config', 'user.name', 'Dev');
    writeFileSync(join(local, 'a.txt'), 'one\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'init');
    writeFileSync(join(local, 'a.txt'), 'local edit\n');
    process.chdir(local);
    const snap = snapshotWorkingTree();
    if ('error' in snap) throw new Error(snap.error);
    git(local, 'push', '-q', remote, `${snap.sha}:refs/heads/sess`);
    const box = tmp();
    git(box, 'clone', '-q', '-b', 'sess', remote, '.');
    git(box, 'config', 'user.email', 'box@example.com');
    git(box, 'config', 'user.name', 'Box');
    return { remote, local, box, snap: snap.sha };
  };

  test('applies the sandbox diff onto the working tree', () => {
    const { remote, local, box, snap } = setup();
    writeFileSync(join(box, 'a.txt'), 'local edit\ncloud edit\n');
    writeFileSync(join(box, 'new.txt'), 'from the cloud\n');
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '-m', 'work');
    git(box, 'push', '-q', 'origin', 'HEAD:refs/heads/sess');
    const head = git(local, 'rev-parse', 'HEAD');

    pullSessionChanges({ url: remote, auth: [] }, 'sess', snap);

    expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('local edit\ncloud edit\n');
    expect(readFileSync(join(local, 'new.txt'), 'utf8')).toBe('from the cloud\n');
    // Changes land uncommitted, as if the agent had run here.
    expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('leaves the tree alone when the patch conflicts with a later local edit', () => {
    const { remote, local, box, snap } = setup();
    writeFileSync(join(box, 'a.txt'), 'cloud rewrite\n');
    git(box, 'commit', '-q', '-am', 'work');
    git(box, 'push', '-q', 'origin', 'HEAD:refs/heads/sess');
    writeFileSync(join(local, 'a.txt'), 'edited again locally\n');

    pullSessionChanges({ url: remote, auth: [] }, 'sess', snap);

    expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('edited again locally\n');
  });
});
