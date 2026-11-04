// The push gate's manifest check, over real git: a bare upstream on disk, the
// API mirror of it, and thin packs built by `git pack-objects` the way
// `git push` builds them.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalGitUpstream } from '../../__tests__/helpers/local-git-upstream';
import { refDeltaBases } from './pack-ref-deltas';
import { pushedManifestRefusal, pushedManifestSyntaxError } from './push-manifest-check';

const GOOD = 'default_agent: kortix\nagents:\n  kortix:\n    prompt: You do the work.\napps:\n  site:\n    always_on: true\n';
const BIG = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');

const upstream = createLocalGitUpstream('push-manifest-check', { 'kortix.yaml': GOOD, 'big.txt': BIG });
afterAll(() => upstream.remove());

const work = join(upstream.repoUrl, '..', 'work');
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.invalid', ...args], { cwd: work }).toString().trim();
const project = {
  projectId: crypto.randomUUID(),
  repoUrl: upstream.repoUrl,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};

/** Commit `files` on top of the upstream's main and return the push it makes: old, new, and the thin pack. */
function commit(files: Record<string, string>) {
  git('reset', '-q', '--hard', 'main');
  const oldSha = git('rev-parse', 'HEAD');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
  git('commit', '-q', '-am', 'change');
  const newSha = git('rev-parse', 'HEAD');
  const pack = execFileSync('git', ['pack-objects', '--thin', '--stdout', '--revs', '-q'], {
    cwd: work,
    input: `${newSha}\n^${oldSha}\n`,
  });
  git('reset', '-q', '--hard', oldSha);
  return { update: { oldSha, newSha }, pack: new Uint8Array(pack), oldSha };
}

describe('refDeltaBases', () => {
  test('names the old file version a thin pack deltas against', () => {
    const { pack, oldSha } = commit({ 'big.txt': `${BIG}\nline 2000` });
    expect(refDeltaBases(pack)).toContain(git('rev-parse', `${oldSha}:big.txt`));
  });

  test('is null for bytes that are not a pack', () => {
    expect(refDeltaBases(new TextEncoder().encode('not a pack at all'))).toBeNull();
  });
});

describe('pushedManifestSyntaxError', () => {
  test('a duplicate key in the pushed kortix.yaml is the error, with its line and column', async () => {
    const { update, pack } = commit({
      'kortix.yaml': `${GOOD}  site:\n    always_on: false\n`,
      'big.txt': `${BIG}\nline 2000`,
    });
    const error = await pushedManifestSyntaxError(project, update, pack);
    expect(error).toEqual({ path: 'kortix.yaml', message: 'Map keys must be unique at line 8, column 3', line: 8, column: 3 });
    expect(pushedManifestRefusal(error!)).toBe(
      'kortix.yaml:8:3 is not valid YAML (Map keys must be unique at line 8, column 3). Fix it, check with `kortix validate`, and push again',
    );
  });

  test('a valid kortix.yaml passes', async () => {
    const { update, pack } = commit({ 'kortix.yaml': `${GOOD}  docs:\n    always_on: false\n` });
    expect(await pushedManifestSyntaxError(project, update, pack)).toBeNull();
  });

  test('a push that does not change kortix.yaml passes', async () => {
    const { update, pack } = commit({ 'big.txt': `${BIG}\nline 2001` });
    expect(await pushedManifestSyntaxError(project, update, pack)).toBeNull();
  });

  test('a pack the check cannot read passes: the gate never blocks on its own failure', async () => {
    const { update } = commit({ 'kortix.yaml': 'a: 1\na: 2\n' });
    expect(await pushedManifestSyntaxError(project, update, new TextEncoder().encode('PACKgarbage'))).toBeNull();
  });
});
