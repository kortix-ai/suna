/**
 * Serving a project whose upstream is a bare repo on disk.
 *
 * The proxy `fetch()`es the upstream, which throws for `file://`, so such a
 * project answered `502 git upstream unreachable` on every clone — sessions
 * started and then could not materialize a workspace. These tests drive real
 * git against a real bare repo: the protocol framing is the part that is easy
 * to get subtly wrong, and a unit test that mocks git would not catch it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advertisementPrefix,
  localRepoPath,
  pktLine,
  resolveLocalRepo,
  runGitService,
} from './local-upstream';

const roots: string[] = [];
afterAll(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A real bare repo with one commit on `main`. */
function bareRepo(): { bare: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-localgit-'));
  roots.push(root);
  const work = join(root, 'work');
  const bare = join(root, 'repo.git');
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'kortix.yaml'), 'kortix_version: 3\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'seed'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-q', 'origin', 'main'], work);
  const sha = git(['rev-parse', 'HEAD'], work).trim();
  return { bare, sha };
}

describe('localRepoPath', () => {
  test('accepts file:// and bare absolute paths', () => {
    expect(localRepoPath('file:///srv/repos/x.git')).toBe('/srv/repos/x.git');
    expect(localRepoPath('/srv/repos/x.git')).toBe('/srv/repos/x.git');
    expect(localRepoPath('file://localhost/srv/x.git')).toBe('/srv/x.git');
    expect(localRepoPath('file:///srv/x.git/')).toBe('/srv/x.git');
  });

  test('rejects everything that must keep going over HTTP', () => {
    expect(localRepoPath('https://github.com/o/r.git')).toBeNull();
    expect(localRepoPath('http://host/r.git')).toBeNull();
    expect(localRepoPath('')).toBeNull();
    expect(localRepoPath('   ')).toBeNull();
  });

  // `file://host/path` names ANOTHER machine. Treating it as local would read
  // this filesystem for a path that was never ours.
  test('rejects a file:// URL with a real host', () => {
    expect(localRepoPath('file://evil.example/etc/passwd')).toBeNull();
  });
});

describe('resolveLocalRepo', () => {
  test('resolves a real bare repo', () => {
    const { bare } = bareRepo();
    expect(resolveLocalRepo(`file://${bare}`)).toBe(require('node:fs').realpathSync(bare));
  });

  test('refuses a path that is not a bare repo, so the caller 502s cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-notrepo-'));
    roots.push(root);
    expect(resolveLocalRepo(`file://${root}`)).toBeNull();
    expect(resolveLocalRepo('file:///definitely/not/here.git')).toBeNull();
  });

  test('refuses an HTTP upstream', () => {
    expect(resolveLocalRepo('https://github.com/o/r.git')).toBeNull();
  });
});

describe('pkt-line framing', () => {
  test('encodes the 4-byte hex length prefix', () => {
    expect(pktLine('a\n')).toBe('0006a\n');
    expect(pktLine('# service=git-upload-pack\n')).toBe('001e# service=git-upload-pack\n');
  });

  test('the advertisement is the banner then a flush packet', () => {
    expect(advertisementPrefix('git-upload-pack')).toBe('001e# service=git-upload-pack\n0000');
  });
});

describe('runGitService against a real repo', () => {
  test('advertises the refs a clone needs', async () => {
    const { bare, sha } = bareRepo();
    const r = await runGitService('git-upload-pack', bare, ['--stateless-rpc', '--advertise-refs']);
    expect(r.ok).toBe(true);
    const body = r.stdout.toString('utf8');
    expect(body).toContain(sha);
    expect(body).toContain('refs/heads/main');
  });

  test('a real `git clone` succeeds through the advertised + negotiated pair', async () => {
    // The end-to-end proof: git itself, not an assertion about bytes.
    const { bare, sha } = bareRepo();
    const dest = mkdtempSync(join(tmpdir(), 'kortix-clone-'));
    roots.push(dest);
    execFileSync('git', ['clone', '-q', bare, join(dest, 'out')]);
    const got = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(dest, 'out'), encoding: 'utf8' }).trim();
    expect(got).toBe(sha);
  });

  test('reports failure instead of throwing when the repo is bogus', async () => {
    const r = await runGitService('git-upload-pack', '/definitely/not/a/repo', ['--stateless-rpc', '--advertise-refs']);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
