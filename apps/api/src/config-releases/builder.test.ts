/**
 * The config release builder against real Git repositories and real archives.
 * No mocked Git: the properties under test (tree IDs, blob IDs, archive bytes)
 * are Git's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { refreshMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import {
  __clearConfigReleaseCachesForTests,
  buildConfigArchive,
  buildConfigRelease,
  ConfigArchiveTooLargeError,
  configReleaseId,
  isTreeObject,
  listConfigFiles,
  toDescriptor,
} from './builder';
import { MemoryConfigArchiveStore, configArchiveKey } from './store';

let root = '';
let work = '';
let remote = '';
let project: GitBackedProject;
let store: MemoryConfigArchiveStore;
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;

function run(cmd: string, args: string[], cwd: string, input?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (...args: string[]) => run('git', args, work);

function write(files: Record<string, string | Buffer>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(work, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
}

function commit(files: Record<string, string | Buffer>, message: string): string {
  write(files);
  git('add', '-A');
  git('commit', '-qm', message);
  git('push', '-q', 'origin', 'main');
  return git('rev-parse', 'HEAD');
}

const MANIFEST = (description: string) =>
  [
    'kortix_version: 2',
    'project:',
    '  name: builder-test',
    'default_agent: kortix',
    'agents:',
    '  kortix:',
    // `skills` is manifest governance: it changes the compiled config.
    `    skills: ${description === 'second' ? 'none' : 'all'}`,
    '  reviewer:',
    '    description: reviews',
    '',
  ].join('\n');

const AGENT = '---\ndescription: main agent\nmode: primary\n---\nYou are the main agent.\n';

/** Extract a tar.gz with the system tar and return the directory. */
function extract(archive: Buffer): string {
  const dir = mkdtempSync(join(root, 'extract-'));
  const tarball = join(dir, '..', `${crypto.randomUUID()}.tar.gz`);
  writeFileSync(tarball, archive);
  run('tar', ['-xzf', tarball, '-C', dir], root);
  return dir;
}

function blobOf(path: string): string {
  const stat = lstatSync(path);
  const content = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('binary');
  const bytes = Buffer.from(content, 'binary');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-config-release-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
});

afterAll(() => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  __clearConfigReleaseCachesForTests();
  const id = crypto.randomUUID();
  work = join(root, `work-${id}`);
  remote = join(root, `remote-${id}.git`);
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote], root);
  run('git', ['init', '-q', '--initial-branch=main', work], root);
  git('config', 'user.email', 't@kortix.invalid');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', remote);
  project = {
    projectId: id,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  store = new MemoryConfigArchiveStore();
});

function seed(): string {
  const sha = commit(
    {
      'kortix.yaml': MANIFEST('first'),
      '.kortix/opencode/opencode.jsonc': '{ "$schema": "https://opencode.ai/config.json" }\n',
      '.kortix/opencode/agents/kortix.md': AGENT,
      '.kortix/opencode/agents/reviewer.md': '---\ndescription: reviews\n---\nReview.\n',
      '.kortix/opencode/skills/demo/SKILL.md': '---\nname: demo\n---\nDemo skill.\n',
      '.kortix/opencode/tools/hello.ts': 'export default {}\n',
      'src/app.ts': 'console.log(1)\n',
    },
    'seed',
  );
  return sha;
}

describe('buildConfigRelease', () => {
  test('returns a descriptor whose files match the archive blob for blob', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const mirror = await refreshMirror(project);
    const tree = run('git', ['rev-parse', `${sha}:.kortix/opencode`], mirror);

    expect(release.format).toBe('config-release-v1');
    expect(release.source_commit).toBe(sha);
    expect(release.config_dir).toBe('.kortix/opencode');
    expect(release.config_tree_id).toBe(tree);
    expect(release.reason).toBeNull();
    expect(release.compiled_governance).not.toBeNull();
    expect(release.compiled_governance_etag).toMatch(/^[0-9a-f]{16}$/);
    expect(release.release_id).toBe(configReleaseId(tree, release.compiled_governance_etag));
    expect(release.release_id).toBe(
      createHash('sha256').update(`${tree}:${release.compiled_governance_etag}`).digest('hex'),
    );
    expect(release.archive?.url).toBe(`/v1/projects/${project.projectId}/config-archives/${tree}`);
    expect(release.files?.map(([path]) => path)).toEqual([
      'agents/kortix.md',
      'agents/reviewer.md',
      'opencode.jsonc',
      'skills/demo/SKILL.md',
      'tools/hello.ts',
    ]);

    const key = configArchiveKey(project.projectId, tree);
    const stored = store.objects.get(key);
    expect(stored).toBeDefined();
    expect(release.archive?.bytes).toBe(stored!.length);

    // Every file in the archive is in `files`, with its exact blob ID, and the
    // paths are relative to the config dir root.
    const dir = extract(stored!);
    for (const [path, mode, blob] of release.files!) {
      expect(mode).toBe('100644');
      expect(blobOf(join(dir, path))).toBe(blob);
    }
    const listed = run('find', ['.', '-type', 'f'], dir)
      .split('\n')
      .map((p) => p.replace(/^\.\//, ''))
      .sort();
    expect(listed).toEqual(release.files!.map(([path]) => path));
  });

  test('keeps symlinks and skips submodule entries', async () => {
    seed();
    symlinkSync('agents/kortix.md', join(work, '.kortix/opencode/linked.md'));
    git('add', '-A');
    // A `commit` tree entry: a submodule pointer with no module content.
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},.kortix/opencode/vendor`);
    git('commit', '-qm', 'symlink and submodule');
    git('push', '-q', 'origin', 'main');
    const sha = git('rev-parse', 'HEAD');

    const release = await buildConfigRelease(project, sha, 'project', { store });
    const linked = release.files!.find(([path]) => path === 'linked.md');
    expect(linked?.[1]).toBe('120000');
    expect(release.files!.some(([path]) => path === 'vendor')).toBe(false);

    const dir = extract(store.objects.get(configArchiveKey(project.projectId, release.config_tree_id!))!);
    expect(lstatSync(join(dir, 'linked.md')).isSymbolicLink()).toBe(true);
    expect(blobOf(join(dir, 'linked.md'))).toBe(linked![2]);
  });

  test('one config tree gives identical archive bytes on every build', async () => {
    const sha = seed();
    const mirror = await refreshMirror(project);
    const tree = run('git', ['rev-parse', `${sha}:.kortix/opencode`], mirror);
    const first = await buildConfigArchive(mirror, tree);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await buildConfigArchive(mirror, tree);
    expect(second.equals(first)).toBe(true);
    // gzip header: no name flag, mtime 0.
    expect(first[3]! & 0x08).toBe(0);
    expect(first.readUInt32LE(4)).toBe(0);
    expect(gunzipSync(first).length).toBeGreaterThan(0);
  });

  test('export-ignore and export-subst in .gitattributes are neutralised, and the mirror gets no writes', async () => {
    seed();
    const sha = commit(
      {
        '.kortix/opencode/.gitattributes': 'secret-notes.md export-ignore\nversion.txt export-subst\n',
        '.kortix/opencode/secret-notes.md': 'kept verbatim\n',
        '.kortix/opencode/version.txt': 'commit $Format:%H$\n',
      },
      'attributes',
    );
    const mirror = await refreshMirror(project);
    const objectsBefore = run('git', ['count-objects', '-v'], mirror);
    const release = await buildConfigRelease(project, sha, 'project', { store });
    expect(run('git', ['count-objects', '-v'], mirror)).toBe(objectsBefore);

    const archive = store.objects.get(configArchiveKey(project.projectId, release.config_tree_id!))!;
    const dir = extract(archive);
    expect(readFileSync(join(dir, 'secret-notes.md'), 'utf8')).toBe('kept verbatim\n');
    expect(readFileSync(join(dir, 'version.txt'), 'utf8')).toBe('commit $Format:%H$\n');
    for (const [path, , blob] of release.files!) expect(blobOf(join(dir, path))).toBe(blob);
    expect(release.files!.map(([path]) => path)).toContain('secret-notes.md');

    const again = await buildConfigArchive(mirror, release.config_tree_id!);
    expect(again.equals(archive)).toBe(true);
  });

  test('a commit outside the config dir keeps the release ID; governance-only changes it', async () => {
    const first = seed();
    const a = await buildConfigRelease(project, first, 'project', { store });

    const unrelated = commit({ 'src/app.ts': 'console.log(2)\n' }, 'app only');
    const b = await buildConfigRelease(project, unrelated, 'project', { store });
    expect(b.release_id).toBe(a.release_id);
    expect(b.config_tree_id).toBe(a.config_tree_id);

    const governance = commit({ 'kortix.yaml': MANIFEST('second') }, 'governance only');
    const c = await buildConfigRelease(project, governance, 'project', { store });
    expect(c.config_tree_id).toBe(a.config_tree_id);
    expect(c.compiled_governance_etag).not.toBe(a.compiled_governance_etag);
    expect(c.release_id).not.toBe(a.release_id);
    // One archive serves all three.
    expect(store.objects.size).toBe(1);

    const files = commit({ '.kortix/opencode/skills/demo/SKILL.md': '---\nname: demo\n---\nv2\n' }, 'skill body');
    const d = await buildConfigRelease(project, files, 'project', { store });
    expect(d.config_tree_id).not.toBe(a.config_tree_id);
    expect(d.release_id).not.toBe(c.release_id);
    expect(store.objects.size).toBe(2);
  });

  test('the agent variant compiles one agent and shares the archive', async () => {
    const sha = seed();
    const whole = await buildConfigRelease(project, sha, 'project', { store });
    const one = await buildConfigRelease(project, sha, 'agent:reviewer', { store });
    expect(one.config_tree_id).toBe(whole.config_tree_id);
    expect(one.archive).toEqual(whole.archive);
    expect(one.compiled_governance_etag).not.toBe(whole.compiled_governance_etag);
    const agents = Object.keys(JSON.parse(one.compiled_governance!).agent ?? {});
    expect(agents).toContain('reviewer');
    expect(agents).not.toContain('kortix');
  });

  test('an unknown selected agent produces no release and names the reason', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'agent:ghost', { store });
    expect(release.release_id).toBeNull();
    expect(release.archive).toBeNull();
    expect(release.reason).toContain('compiled governance failed');
  });

  test('a commit with no config dir produces no release', async () => {
    const sha = commit({ 'kortix.yaml': MANIFEST('first'), 'README.md': 'x\n' }, 'no config');
    const release = await buildConfigRelease(project, sha, 'project', { store });
    expect(release.release_id).toBeNull();
    expect(release.config_dir).toBeNull();
    expect(release.archive).toBeNull();
    expect(release.files).toBeNull();
    expect(release.reason).toBe('the commit has no OpenCode config dir');
    expect(release.compiled_governance).not.toBeNull();
  });

  test('a config dir over the archive limit produces no release', async () => {
    const sha = commit(
      {
        'kortix.yaml': MANIFEST('first'),
        '.kortix/opencode/opencode.json': '{}\n',
        // Random bytes do not compress: the gzip stays above 4 MiB.
        '.kortix/opencode/blob.bin': randomBytes(4 * 1024 * 1024 + 4096),
      },
      'huge',
    );
    const release = await buildConfigRelease(project, sha, 'project', { store });
    expect(release.release_id).toBeNull();
    expect(release.config_tree_id).toMatch(/^[0-9a-f]{40}$/);
    expect(release.reason).toContain('exceeds the 4194304-byte archive limit');
    expect(store.objects.size).toBe(0);

    const mirror = await refreshMirror(project);
    await expect(buildConfigArchive(mirror, release.config_tree_id!, 1024)).rejects.toBeInstanceOf(
      ConfigArchiveTooLargeError,
    );
  });

  test('a store failure still returns a complete descriptor', async () => {
    const sha = seed();
    store.failWith = new Error('store down');
    const release = await buildConfigRelease(project, sha, 'project', { store });
    expect(release.release_id).toMatch(/^[0-9a-f]{64}$/);
    expect(release.archive?.bytes).toBeGreaterThan(0);
    expect(release.files?.length).toBe(5);
  });

  test('caches by (project, commit, variant)', async () => {
    const sha = seed();
    const first = await buildConfigRelease(project, sha, 'project', { store });
    const second = await buildConfigRelease(project, sha, 'project', { store });
    expect(second).toBe(first);
    expect(store.puts).toBe(1);
    const other = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(other).not.toBe(first);
  });

  test('session-files mode drops the archive and the files, and keeps base governance', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const descriptor = toDescriptor(release, 'session-files');
    expect(descriptor.mode).toBe('session-files');
    expect(descriptor.archive).toBeNull();
    expect(descriptor.files).toBeNull();
    expect(descriptor.compiled_governance).toBe(release.compiled_governance);
    expect(toDescriptor(release, 'follow-base').archive).toEqual(release.archive);
  });

  test('a session without repository access gets governance and no archive', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'agent:reviewer', { store });
    const descriptor = toDescriptor(release, 'follow-base', { repositoryAccess: false });
    expect(descriptor.archive).toBeNull();
    expect(descriptor.files).toBeNull();
    expect(descriptor.config_tree_id).toBeNull();
    expect(descriptor.release_id).toBeNull();
    expect(descriptor.reason).toBe('repository access withheld');
    expect(descriptor.compiled_governance).toBe(release.compiled_governance);
    expect(descriptor.compiled_governance_etag).toBe(release.compiled_governance_etag);
  });
});

describe('mirror helpers', () => {
  test('isTreeObject accepts a tree and rejects a blob, a commit, and junk', async () => {
    const sha = seed();
    const mirror = await refreshMirror(project);
    const tree = run('git', ['rev-parse', `${sha}:.kortix/opencode`], mirror);
    const blob = run('git', ['rev-parse', `${sha}:kortix.yaml`], mirror);
    expect(await isTreeObject(mirror, tree)).toBe(true);
    expect(await isTreeObject(mirror, blob)).toBe(false);
    expect(await isTreeObject(mirror, sha)).toBe(false);
    expect(await isTreeObject(mirror, 'f'.repeat(40))).toBe(false);
    expect(await isTreeObject(mirror, 'HEAD')).toBe(false);
    expect((await listConfigFiles(mirror, tree)).length).toBe(5);
  });
});
