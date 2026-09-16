import { expect, test } from 'bun:test';
import { compileAgentResources, resolveCompiledAgentResources } from './compile-agent-resources';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('compile resources reads only the selected agent files and preserves binary bytes', async () => {
  const reads: string[] = [];
  const resources = await compileAgentResources(
    {
      agents: {
        selected: {
          resources: {
            worker: { rules: 'rules.json' },
            environment: [
              { source: 'template.bin', target: '/workspace/template.bin', mode: 'seed' },
            ],
          },
        },
        other: { resources: { worker: { secret: 'other.json' } } },
      },
    },
    'selected',
    async (path) => {
      reads.push(path);
      return path === 'rules.json' ? Buffer.from('{"currency":"EUR"}') : Buffer.from([0, 255]);
    },
  );
  expect(reads).toEqual(['rules.json', 'template.bin']);
  expect(resources).toHaveLength(2);
  expect(resources[0]).toMatchObject({ placement: 'worker', name: 'rules', size: 18 });
  expect(Buffer.from(resources[1]!.content, 'base64')).toEqual(Buffer.from([0, 255]));
});

test('resource compilation reads pinned Git bytes and rejects missing files, directories and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-resource-git-'));
  const previous = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'mirrors');
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(['git', ...args], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_COMMITTER_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@kortix.test',
        GIT_COMMITTER_EMAIL: 'test@kortix.test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
  };
  try {
    await git('init', '-b', 'main');
    await mkdir(join(repo, 'assets'));
    await writeFile(join(repo, 'assets/règles json'), '{"revision":1}');
    await symlink('règles json', join(repo, 'assets/link'));
    await writeFile(
      join(repo, 'kortix.yaml'),
      JSON.stringify({
        kortix_version: 3,
        default_agent: 'selected',
        agents: Object.fromEntries(
          [
            ['selected', 'assets/règles json'],
            ['symlink', 'assets/link'],
            ['directory', 'assets'],
            ['missing', 'missing.txt'],
          ].map(([name, source]) => [name, { resources: { worker: { rules: source } } }]),
        ),
      }),
    );
    await git('add', '.');
    await git('commit', '-m', 'Resource source');
    const pinned = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'assets/règles json'), '{"revision":2}');
    await git('commit', '-am', 'New default branch resources');
    const project = {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${repo}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
    };
    const compiled = await resolveCompiledAgentResources(project, pinned, 'selected');
    expect(Buffer.from(compiled[0]!.content, 'base64').toString()).toBe('{"revision":1}');
    for (const agent of ['symlink', 'directory', 'missing'])
      await expect(resolveCompiledAgentResources(project, pinned, agent)).rejects.toThrow(
        /regular Git file/,
      );
  } finally {
    if (previous === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('compile resources bounds bytes and rejects malformed declarations before reading', async () => {
  await expect(
    compileAgentResources(
      { agents: { a: { resources: { worker: { rules: '../secret' } } } } },
      'a',
      async () => {
        throw new Error('must not read');
      },
    ),
  ).rejects.toThrow(/source path|relative file/);
  await expect(
    compileAgentResources(
      { agents: { a: { resources: { worker: { rules: 'large.bin' } } } } },
      'a',
      async () => new Uint8Array(8 * 1024 * 1024 + 1),
    ),
  ).rejects.toThrow(/8 MiB/);
});
