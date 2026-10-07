/**
 * The config release builder against real Git repositories and real archives.
 * No mocked Git: the properties under test (tree IDs, blob IDs, archive bytes)
 * are Git's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, chmodSync, existsSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { refreshMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { buildPlatformMetaOpenCodeConfig } from '../projects/lib/platform-meta-agent';
import {
  __clearConfigReleaseCachesForTests,
  buildConfigArchive,
  buildConfigRelease,
  ConfigArchiveTooLargeError,
  configReleaseId,
  isTreeObject,
  listConfigFiles,
  storeConfigArchive,
  toDescriptor,
} from './builder';
import { configArchiveKey } from './store';
import { MemoryConfigArchiveStore } from './__tests__/fakes';

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
  // Resolve the entry in one call: readlink fails with EINVAL on a regular
  // file, so no separate lstat can race the read (CodeQL js/file-system-race).
  let content: string;
  try {
    content = readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
    content = readFileSync(path).toString('binary');
  }
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

const ROOT_MANIFEST = [
  'kortix_version: 2',
  'project:',
  '  name: builder-test',
  'default_agent: kortix',
  'agents:',
  '  kortix:',
  '    file: agents/kortix.md',
  '    skills: all',
  '',
].join('\n');

/** The harness-neutral layout: agents/ and skills/ at the root, OpenCode files in harnesses/opencode. */
function seedRootLayout(extra: Record<string, string> = {}): string {
  return commit(
    {
      'kortix.yaml': ROOT_MANIFEST,
      'agents/kortix.md': AGENT,
      'skills/demo/SKILL.md': '---\nname: demo\n---\nDemo skill.\n',
      'skills/demo/reference.md': 'More.\n',
      // No SKILL.md anywhere under it: not a skill, never part of a release.
      'skills/notes/readme.txt': 'not a skill\n',
      'harnesses/opencode/opencode.jsonc': '{ "$schema": "https://opencode.ai/config.json" }\n',
      'harnesses/opencode/tools/hello.ts': 'export default {}\n',
      ...extra,
    },
    'seed root layout',
  );
}

describe('buildConfigRelease on the root project layout', () => {
  test('releases the whole commit tree, at the paths the repository uses, and the archive holds exactly the listed files', async () => {
    const sha = seedRootLayout();
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const mirror = await refreshMirror(project);

    expect(release.reason).toBeNull();
    expect(release.config_dir).toBe('harnesses/opencode');
    // The commit's own root tree: the same files a checkout holds in /workspace.
    expect(release.config_tree_id).toBe(run('git', ['rev-parse', `${sha}^{tree}`], mirror));
    expect(release.archive?.url).toBe(`/v1/projects/${project.projectId}/config-archives/${release.config_tree_id}`);
    expect(release.files?.map(([path]) => path)).toEqual(run('git', ['ls-tree', '-r', '--name-only', sha], mirror).split('\n').sort());
    expect(release.files?.map(([path]) => path)).toEqual([
      'agents/kortix.md',
      'harnesses/opencode/opencode.jsonc',
      'harnesses/opencode/tools/hello.ts',
      'kortix.yaml',
      'skills/demo/SKILL.md',
      'skills/demo/reference.md',
      'skills/notes/readme.txt',
    ]);

    const archive = store.objects.get(configArchiveKey(project.projectId, release.config_tree_id!));
    expect(release.archive?.bytes).toBe(archive!.length);
    const dir = extract(archive!);
    for (const [path, , blob] of release.files!) expect(blobOf(join(dir, path))).toBe(blob);
    const listed = run('find', ['.', '-type', 'f'], dir)
      .split('\n')
      .map((p) => p.replace(/^\.\//, ''))
      .sort();
    expect(listed).toEqual(release.files!.map(([path]) => path));
  });

  test('the composed tree and its archive are deterministic', async () => {
    const sha = seedRootLayout();
    const first = await buildConfigRelease(project, sha, 'project', { store, noCache: true });
    const firstBytes = store.objects.get(configArchiveKey(project.projectId, first.config_tree_id!))!;
    __clearConfigReleaseCachesForTests();
    const again = new MemoryConfigArchiveStore();
    const second = await buildConfigRelease(project, sha, 'project', { store: again, noCache: true });
    expect(second.config_tree_id).toBe(first.config_tree_id);
    expect(second.release_id).toBe(first.release_id);
    expect(again.objects.get(configArchiveKey(project.projectId, second.config_tree_id!))!.equals(firstBytes)).toBe(true);
  });

  test('a composed release whose archive bytes are already cached does not build the archive again', async () => {
    const sha = seedRootLayout();
    const first = await buildConfigRelease(project, sha, 'project', { store });
    expect(first.archive?.bytes).toBeGreaterThan(0);

    // Count gzip runs: the archive pipeline is `git archive` piped through
    // `gzip -n`, so a gzip run under a PATH shim means the archive was built.
    const shimDir = join(root, 'gzip-shim');
    mkdirSync(shimDir, { recursive: true });
    const counter = join(root, 'gzip-runs');
    const gzips = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0);
    const realGzip = run('which', ['gzip'], root);
    writeFileSync(join(shimDir, 'gzip'), `#!/bin/sh\necho run >> '${counter}'\nexec '${realGzip}' "$@"\n`);
    chmodSync(join(shimDir, 'gzip'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${previousPath}`;
    try {
      const again = new MemoryConfigArchiveStore();
      const second = await buildConfigRelease(project, sha, 'project', { store: again, noCache: true });
      expect(second.release_id).toBe(first.release_id);
      expect(second.archive?.bytes).toBe(first.archive?.bytes);
      // The size cache already held the tree's key: the second build runs no
      // archive pipeline (the first build ran before the shim, so 0 is the
      // count of shims-era gzip runs), and nothing is published again.
      expect(gzips()).toBe(0);
      expect(again.puts).toBe(0);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test('every file keeps its repository path: the pi config dir, an explicit pi.config_dir, and files outside every config dir', async () => {
    const sha = seedRootLayout({
      'harnesses/pi/extensions/guard.ts': 'export default () => {}\n',
      'harnesses/pi/skills/native/SKILL.md': '---\nname: native\n---\nA pi skill.\n',
      'team/pi/prompts/review.md': 'Review.\n',
      'shared/helper.ts': 'export const HELPER = 1\n',
      'AGENTS.md': 'Project rules.\n',
    });
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const paths = release.files!.map(([path]) => path);
    for (const path of ['harnesses/pi/extensions/guard.ts', 'harnesses/pi/skills/native/SKILL.md', 'team/pi/prompts/review.md', 'shared/helper.ts', 'AGENTS.md']) {
      expect(paths).toContain(path);
    }
    expect(paths.some((path) => path.startsWith('pi/'))).toBe(false);
  });

  test('any change to a tracked file moves the release', async () => {
    const base = seedRootLayout();
    const first = await buildConfigRelease(project, base, 'project', { store });
    const changed = commit({ 'src/app.ts': 'console.log(2)\n' }, 'code only');
    const second = await buildConfigRelease(project, changed, 'project', { store });
    expect(second.release_id).not.toBe(first.release_id);
    expect(second.files!.map(([path]) => path)).toContain('src/app.ts');
  });
});

describe('buildConfigRelease', () => {
  test('returns a descriptor whose files match the archive blob for blob', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const mirror = await refreshMirror(project);
    const tree = run('git', ['rev-parse', `${sha}^{tree}`], mirror);

    expect(release.format).toBe('config-release-v2');
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
      '.kortix/opencode/agents/kortix.md',
      '.kortix/opencode/agents/reviewer.md',
      '.kortix/opencode/opencode.jsonc',
      '.kortix/opencode/skills/demo/SKILL.md',
      '.kortix/opencode/tools/hello.ts',
      'kortix.yaml',
      'src/app.ts',
    ]);

    const key = configArchiveKey(project.projectId, tree);
    const stored = store.objects.get(key);
    expect(stored).toBeDefined();
    expect(release.archive?.bytes).toBe(stored!.length);

    // Every file in the archive is in `files`, with its exact blob ID, and the
    // paths are relative to the repository root.
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
    const linked = release.files!.find(([path]) => path === '.kortix/opencode/linked.md');
    expect(linked?.[1]).toBe('120000');
    expect(release.files!.some(([path]) => path === '.kortix/opencode/vendor')).toBe(false);

    const dir = extract(store.objects.get(configArchiveKey(project.projectId, release.config_tree_id!))!);
    expect(lstatSync(join(dir, '.kortix/opencode/linked.md')).isSymbolicLink()).toBe(true);
    expect(blobOf(join(dir, '.kortix/opencode/linked.md'))).toBe(linked![2]);
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
    expect(readFileSync(join(dir, '.kortix/opencode/secret-notes.md'), 'utf8')).toBe('kept verbatim\n');
    expect(readFileSync(join(dir, '.kortix/opencode/version.txt'), 'utf8')).toBe('commit $Format:%H$\n');
    for (const [path, , blob] of release.files!) expect(blobOf(join(dir, path))).toBe(blob);
    expect(release.files!.map(([path]) => path)).toContain('.kortix/opencode/secret-notes.md');

    const again = await buildConfigArchive(mirror, release.config_tree_id!);
    expect(again.equals(archive)).toBe(true);
  });

  // KRTX-1728: the too-large reason, the docs and `kortix validate` tell an
  // owner to mark big paths export-ignore. The release used to ship them
  // anyway, so the remedy changed nothing and the repository stayed over the cap.
  test('a path the repository marks export-ignore is left out of the release, outside the config dir', async () => {
    seed();
    const sha = commit(
      {
        '.gitattributes': 'assets/** export-ignore\nfixtures export-ignore\n',
        // Random bytes do not compress: each stays over the 32 KiB test cap.
        'assets/hero.bin': randomBytes(48 * 1024),
        'assets/deep/clip.bin': randomBytes(48 * 1024),
        'fixtures/big.json': randomBytes(48 * 1024),
        // The config dir is exempt: what it marks export-ignore still ships verbatim.
        '.kortix/opencode/.gitattributes': 'secret-notes.md export-ignore\n',
        '.kortix/opencode/secret-notes.md': 'kept verbatim\n',
      },
      'export-ignored assets',
    );
    const release = await buildConfigRelease(project, sha, 'project', { store, archiveLimit: 32 * 1024 });
    expect(release.reason ?? null).toBeNull();
    expect(release.release_id).not.toBeNull();

    const paths = release.files!.map(([path]) => path);
    expect(paths.filter((path) => path.startsWith('assets/') || path.startsWith('fixtures/'))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining(['.gitattributes', 'src/app.ts', '.kortix/opencode/secret-notes.md']));

    const dir = extract(store.objects.get(configArchiveKey(project.projectId, release.config_tree_id!))!);
    expect(existsSync(join(dir, 'assets'))).toBe(false);
    expect(existsSync(join(dir, 'fixtures'))).toBe(false);
    expect(readFileSync(join(dir, '.kortix/opencode/secret-notes.md'), 'utf8')).toBe('kept verbatim\n');
    // On-box blob verification: every listed file is in the archive, byte for byte.
    for (const [path, , blob] of release.files!) expect(blobOf(join(dir, path))).toBe(blob);
  });

  test('a code-only commit and a governance-only commit each move the release', async () => {
    const first = seed();
    const a = await buildConfigRelease(project, first, 'project', { store });

    const unrelated = commit({ 'src/app.ts': 'console.log(2)\n' }, 'app only');
    const b = await buildConfigRelease(project, unrelated, 'project', { store });
    expect(b.config_tree_id).not.toBe(a.config_tree_id);
    expect(b.release_id).not.toBe(a.release_id);
    expect(b.compiled_governance_etag).toBe(a.compiled_governance_etag);

    const governance = commit({ 'kortix.yaml': MANIFEST('second') }, 'governance only');
    const c = await buildConfigRelease(project, governance, 'project', { store });
    expect(c.compiled_governance_etag).not.toBe(b.compiled_governance_etag);
    expect(c.release_id).not.toBe(b.release_id);
    expect(store.objects.size).toBe(3);
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

  // 2026-10-05: a pi project with no OpenCode config dir got a governance-only
  // release, and pi lost its root skills and its own config dir.
  test('a commit with no OpenCode config dir still releases its whole tree, with no config dir named', async () => {
    const sha = commit(
      {
        'kortix.yaml': MANIFEST('first'),
        'skills/demo/SKILL.md': '---\nname: demo\n---\nDemo skill.\n',
        'harnesses/pi/skills/native/SKILL.md': '---\nname: native\n---\nA pi skill.\n',
      },
      'pi only',
    );
    const release = await buildConfigRelease(project, sha, 'project', { store });
    expect(release.reason).toBeNull();
    expect(release.release_id).toMatch(/^[0-9a-f]{64}$/);
    expect(release.archive).not.toBeNull();
    expect(release.config_dir).toBeNull();
    expect(release.files!.map(([path]) => path)).toEqual(['harnesses/pi/skills/native/SKILL.md', 'kortix.yaml', 'skills/demo/SKILL.md']);
  });

  // Prod 2026-10-02: the meta coordinator's box has no project checkout and its
  // image has no `bun`. It was assigned the `project` release, could not install
  // the tool dependencies, and its failures quarantined that release for every
  // session of the project.
  test('the meta variant is the platform governance alone, whatever the config dir holds', async () => {
    const first = await buildConfigRelease(project, seed(), 'meta', { store });
    expect(first.compiled_governance).toBe(buildPlatformMetaOpenCodeConfig());
    expect(first.release_id).toBe(configReleaseId(null, first.compiled_governance_etag));
    expect(first.config_dir).toBeNull();
    expect(first.config_tree_id).toBeNull();
    expect(first.archive).toBeNull();
    expect(first.files).toBeNull();
    expect(first.reason).toBeNull();
    expect(toDescriptor(first, { repositoryAccess: true }).archive).toBeNull();

    const moved = commit({ '.kortix/opencode/tools/hello.ts': 'export default { changed: true }\n' }, 'tool change');
    expect((await buildConfigRelease(project, moved, 'meta', { store })).release_id).toBe(first.release_id);
  });

  test('a repository over the archive limit produces no release', async () => {
    const sha = commit(
      {
        'kortix.yaml': MANIFEST('first'),
        '.kortix/opencode/opencode.json': '{}\n',
        // Random bytes do not compress: 64 KiB stays over the 32 KiB test cap.
        '.kortix/opencode/blob.bin': randomBytes(64 * 1024),
      },
      'huge',
    );
    const release = await buildConfigRelease(project, sha, 'project', { store, archiveLimit: 32 * 1024 });
    expect(release.release_id).toBeNull();
    expect(release.config_tree_id).toMatch(/^[0-9a-f]{40}$/);
    expect(release.reason).toContain(`exceeds the ${32 * 1024}-byte config archive limit`);
    expect(release.reason).toContain('`kortix validate` lists the largest files');
    expect(store.objects.size).toBe(0);
    // The answer is a fact of the commit: every box's descriptor request (one
    // per minute per box) must not rebuild and gzip the whole tree again.
    expect(await buildConfigRelease(project, sha, 'project', { store, archiveLimit: 32 * 1024 })).toBe(release);

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
    expect(release.files?.length).toBe(7);
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

  test('every descriptor follows the base branch and carries its archive', async () => {
    // There is no second mode. A session that edited its own config dir under
    // /workspace still receives the base branch's release; its edits reach the
    // box only once they are pushed to the base branch.
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'project', { store });
    const descriptor = toDescriptor(release);
    expect(descriptor.mode).toBe('follow-base');
    expect(descriptor.archive).toEqual(release.archive);
    expect(descriptor.files).toEqual(release.files);
    expect(descriptor.compiled_governance).toBe(release.compiled_governance);
  });

  test('a session without repository access gets governance and no archive', async () => {
    const sha = seed();
    const release = await buildConfigRelease(project, sha, 'agent:reviewer', { store });
    const descriptor = toDescriptor(release, { repositoryAccess: false });
    expect(descriptor.archive).toBeNull();
    expect(descriptor.files).toBeNull();
    expect(descriptor.config_tree_id).toBeNull();
    expect(descriptor.release_id).toBe(configReleaseId(null, release.compiled_governance_etag));
    expect(descriptor.release_id).not.toBe(release.release_id);
    expect(descriptor.reason).toBe('repository access withheld');
    expect(descriptor.compiled_governance).toBe(release.compiled_governance);
    expect(descriptor.compiled_governance_etag).toBe(release.compiled_governance_etag);
  });
});

describe('configReleaseId', () => {
  test('is null only when both parts are null', () => {
    expect(configReleaseId(null, null)).toBeNull();
    expect(configReleaseId(null, 'e'.repeat(16))).toBe(createHash('sha256').update(`:${'e'.repeat(16)}`).digest('hex'));
    expect(configReleaseId('t'.repeat(40), null)).toBe(createHash('sha256').update(`${'t'.repeat(40)}:`).digest('hex'));
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

describe('storeConfigArchive — publish then bound retention', () => {
  const project = '0b7c9f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
  const key = (n: string) => configArchiveKey(project, n.repeat(40));

  test('a new archive prunes the project down to the retention bound', async () => {
    const store = new MemoryConfigArchiveStore();
    for (const n of ['1', '2', '3']) {
      expect(await storeConfigArchive(store, project, key(n), Buffer.from(n), { keep: 2 })).toBe('created');
    }
    expect([...store.objects.keys()]).toEqual([key('2'), key('3')]);
  });

  test('an archive that was already published prunes nothing', async () => {
    const store = new MemoryConfigArchiveStore();
    await storeConfigArchive(store, project, key('1'), Buffer.from('1'), { keep: 1 });
    await storeConfigArchive(store, project, key('2'), Buffer.from('2'), { keep: 1 });
    const pruned: string[] = [];
    store.pruneProject = async (...args) => {
      pruned.push(String(args[1]));
      return [];
    };
    expect(await storeConfigArchive(store, project, key('2'), Buffer.from('2'), { keep: 1 })).toBe('exists');
    expect(pruned).toEqual([]);
  });

  test('keep 0 hands retention to the bucket lifecycle rule: nothing is listed or deleted', async () => {
    const store = new MemoryConfigArchiveStore();
    let pruned = 0;
    store.pruneProject = async () => {
      pruned += 1;
      return [];
    };
    for (const n of ['1', '2', '3']) {
      await storeConfigArchive(store, project, key(n), Buffer.from(n), { keep: 0 });
    }
    expect(pruned).toBe(0);
    expect(store.objects.size).toBe(3);
  });

  test('a prune failure never fails the publish', async () => {
    const store = new MemoryConfigArchiveStore();
    store.pruneProject = async () => {
      throw new Error('list refused');
    };
    expect(await storeConfigArchive(store, project, key('1'), Buffer.from('1'), { keep: 2 })).toBe('created');
    expect(store.objects.size).toBe(1);
  });

  test('a store failure is reported, never thrown', async () => {
    const store = new MemoryConfigArchiveStore();
    store.failWith = new Error('store down');
    expect(await storeConfigArchive(store, project, key('1'), Buffer.from('1'), { keep: 2 })).toBe('failed');
  });
});
