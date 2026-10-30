import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Lockfiles are the shipped dependency inventory, including npm aliases.
test('every resolved undici release includes the GHSA-xjj6-f33q-929c fix', () => {
  const lock = Bun.YAML.parse(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'));
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('/undici@'))
    .map((key) => key.slice('/undici@'.length).split('(')[0]);
  expect(versions.length).toBeGreaterThan(0);
  for (const version of versions) {
    expect(Bun.semver.satisfies(version, '>=6.29.1 <7 || >=7.30.1 <8 || >=8.12.2'), version).toBe(true);
  }
});

test('the independently installed daemon lockfile includes the undici fix', () => {
  const lock = Bun.JSONC.parse(readFileSync(new URL('../../apps/kortix-sandbox-agent-server/bun.lock', import.meta.url), 'utf8'));
  const packages = Object.values(lock.packages).filter((entry) => entry[0].startsWith('undici@'));
  expect(packages.length).toBeGreaterThan(0);
  for (const [name] of packages) {
    expect(Bun.semver.satisfies(name.slice('undici@'.length), '>=8.12.2')).toBe(true);
  }
});

test('the scanner lockfile includes the undici fixes', () => {
  const lock = Bun.YAML.parse(readFileSync(new URL('../../.deepsec/pnpm-lock.yaml', import.meta.url), 'utf8'));
  const versions = Object.keys(lock.packages).filter((key) => key.startsWith('undici@'));
  expect(versions.length).toBeGreaterThan(0);
  for (const name of versions) {
    expect(Bun.semver.satisfies(name.slice('undici@'.length), '>=7.30.1 <8 || >=8.12.2')).toBe(true);
  }
});

test('patched undici 8 imports and completes HTTP requests on Node 22', () => {
  const result = Bun.spawnSync(['node', '--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { createRequire } from 'node:module';
    const { realpathSync } = await import('node:fs');
    const require = createRequire(realpathSync('apps/kortix-sandbox-agent-server/node_modules/@earendil-works/pi-coding-agent') + '/package.json');
    const { request } = require('undici');
    const server = createServer((req, res) => res.end('synthetic-ok'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await request('http://127.0.0.1:' + server.address().port);
      if (response.statusCode !== 200 || await response.body.text() !== 'synthetic-ok') process.exitCode = 1;
    } finally { server.close(); }
  `]);
  expect(new TextDecoder().decode(result.stderr)).toBe('');
  expect(result.exitCode).toBe(0);
});
