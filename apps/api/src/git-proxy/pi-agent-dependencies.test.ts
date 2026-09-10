import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c, Header } from 'tar';
import { gzipSync } from 'node:zlib';
import { compilePiAgentModule } from './pi-agent-module';
import { preparePiDependencies } from './pi-agent-dependencies';

async function archive() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-dep-test-'));
  try {
    await mkdir(join(dir, 'package'));
    await writeFile(
      join(dir, 'package', 'package.json'),
      JSON.stringify({
        name: 'pi-test-helper',
        version: '1.0.0',
        main: 'index.js',
        scripts: { postinstall: 'touch NEVER_RUN_PROJECT_SCRIPT' },
      }),
    );
    await writeFile(join(dir, 'package', 'index.js'), `module.exports='LOCKED_HELPER';`);
    await c({ cwd: dir, file: join(dir, 'package.tgz'), gzip: true }, ['package']);
    return await readFile(join(dir, 'package.tgz'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function inputs(bytes: Buffer) {
  const packageJson = JSON.stringify({ dependencies: { 'pi-test-helper': '1.0.0' } });
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'pi-test-helper': '1.0.0' } },
      'node_modules/pi-test-helper': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/pi-test-helper/-/pi-test-helper-1.0.0.tgz',
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      },
    },
  };
  return { packageJson, packageLock: JSON.stringify(lock) };
}

test('locked npm source is verified and unpacked without running package lifecycle scripts', async () => {
  const bytes = await archive();
  const urls: string[] = [];
  const prepared = await preparePiDependencies({
    ...inputs(bytes),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(bytes);
    },
  });
  try {
    expect(
      await readFile(join(prepared.root, 'node_modules/pi-test-helper/index.js'), 'utf8'),
    ).toContain('LOCKED_HELPER');
    expect(await Bun.file(join(prepared.root, 'NEVER_RUN_PROJECT_SCRIPT')).exists()).toBe(false);
    expect(
      await Bun.file(
        join(prepared.root, 'node_modules/pi-test-helper/NEVER_RUN_PROJECT_SCRIPT'),
      ).exists(),
    ).toBe(false);
    const module = await compilePiAgentModule({
      entry: 'agents/locked.ts',
      files: {
        'agents/locked.ts': `import helper from 'pi-test-helper';export default ()=>({thinkingLevel:helper==='LOCKED_HELPER'?'low':'high'});`,
      },
      dependencyRoot: prepared.root,
      dependencyLockSha256: prepared.lockSha256,
    });
    const artifact = join(prepared.root, 'proof.cjs');
    await writeFile(
      artifact,
      module.source + '\nconsole.log(JSON.stringify(globalThis.__KORTIX_PI_AGENT__({})));',
    );
    const child = Bun.spawn(['node', artifact], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ thinkingLevel: 'low' });
    expect(module.dependencyLockSha256).toBe(prepared.lockSha256);
    expect(urls).toEqual(['https://registry.npmjs.org/pi-test-helper/-/pi-test-helper-1.0.0.tgz']);
    expect(prepared.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await prepared.cleanup();
  }
  expect(await Bun.file(join(prepared.root, 'node_modules/pi-test-helper/index.js')).exists()).toBe(
    false,
  );
});

test('dependency imports require matching manifests, integrity, and public registry sources', async () => {
  const bytes = await archive();
  const input = inputs(bytes);
  let requests = 0;
  const fetch = async () => {
    requests++;
    return new Response(bytes);
  };
  const original = JSON.parse(input.packageLock);
  for (const patch of [
    { resolved: 'http://localhost/private' },
    { resolved: 'https://registry.npmjs.org@localhost/private' },
    { integrity: 'sha512-invalid' },
    { link: true },
  ]) {
    const lock = structuredClone(original);
    Object.assign(lock.packages['node_modules/pi-test-helper'], patch);
    await expect(
      preparePiDependencies({ ...input, packageLock: JSON.stringify(lock), fetch }),
    ).rejects.toThrow();
  }
  expect(requests).toBe(0);
  await expect(
    preparePiDependencies({
      ...input,
      packageJson: JSON.stringify({ dependencies: { 'pi-test-helper': '2.0.0' } }),
      fetch,
    }),
  ).rejects.toThrow();
  await expect(
    preparePiDependencies({ ...input, fetch: async () => new Response('modified archive') }),
  ).rejects.toThrow(/integrity/);
});

test('integrity-valid archives still reject traversal, links, nested node_modules, and oversized files', async () => {
  for (const entry of [
    { path: 'package/../../escape.txt', type: 'File', size: 0 },
    { path: '/tmp/pi-archive-escape', type: 'File', size: 0 },
    { path: 'package/link', type: 'SymbolicLink', linkpath: '../../escape.txt', size: 0 },
    { path: 'package/link', type: 'Link', linkpath: '../../escape.txt', size: 0 },
    { path: 'package/node_modules/hidden/index.js', type: 'File', size: 0 },
    { path: 'package/huge.txt', type: 'File', size: 9 * 1024 * 1024 },
  ] as const) {
    const header = new Header({ ...entry, mode: 0o644 });
    header.encode();
    const bytes = gzipSync(
      Buffer.concat([header.block!, Buffer.alloc(entry.size), Buffer.alloc(1024)]),
    );
    await expect(
      preparePiDependencies({ ...inputs(bytes), fetch: async () => new Response(bytes) }),
    ).rejects.toThrow(/unsupported paths|links|oversized/);
  }
});
