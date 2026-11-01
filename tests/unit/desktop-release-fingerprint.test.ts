import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildJob,
  dependencyClosure,
  sourceFiles,
} from '../../apps/desktop-electron/scripts/release-fingerprint.mjs';

// A prod release reuses the previous desktop installers when this fingerprint
// is unchanged, so installed apps get no update prompt (deploy-prod.yml
// desktop-plan). A missed input ships a stale app; an extra input only costs
// a rebuild.
const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/deploy-prod.yml'), 'utf8');

const lock = {
  importers: {
    'apps/desktop-electron': {
      dependencies: { 'electron-updater': { specifier: '^6', version: '6.8.9' } },
      devDependencies: { electron: { specifier: '^42', version: '42.11.18' } },
    },
    'packages/agent-tunnel': {
      dependencies: { ws: { specifier: '^8', version: '8.21.3' } },
      devDependencies: { typescript: { specifier: '^5', version: '5.9.3' } },
    },
  },
  packages: {
    '/electron-updater@6.8.9': { resolution: { integrity: 'sha512-u' }, dependencies: { semver: '7.7.4' } },
    '/electron@42.11.18': {
      resolution: { integrity: 'sha512-e' },
      dependencies: { '@types/node': '26.6.4', 'extract-zip': '2.0.1' },
    },
    '/extract-zip@2.0.1': { resolution: { integrity: 'sha512-z' }, optionalDependencies: { semver: '7.7.4' } },
    '/semver@7.7.4': { resolution: { integrity: 'sha512-s' } },
    '/ws@8.21.3': { resolution: { integrity: 'sha512-w' } },
    '/@types/node@26.6.4': { resolution: { integrity: 'sha512-t' } },
    '/typescript@5.9.3': { resolution: { integrity: 'sha512-ts' } },
  },
};

describe('desktop release fingerprint', () => {
  it('covers the transitive closure of what the app loads, nothing else', () => {
    expect(dependencyClosure(lock)).toEqual([
      '/electron-updater@6.8.9 sha512-u',
      '/electron@42.11.18 sha512-e',
      '/extract-zip@2.0.1 sha512-z',
      '/semver@7.7.4 sha512-s',
      '/ws@8.21.3 sha512-w',
    ]);
  });

  it('changes when a transitive dependency resolves to another version', () => {
    const bumped = structuredClone(lock);
    bumped.packages['/semver@7.7.5'] = { resolution: { integrity: 'sha512-s2' } };
    bumped.packages['/electron-updater@6.8.9'].dependencies.semver = '7.7.5';
    expect(dependencyClosure(bumped)).not.toEqual(dependencyClosure(lock));
  });

  it('refuses a lockfile it cannot resolve instead of hashing a partial graph', () => {
    const broken = structuredClone(lock);
    delete broken.packages['/semver@7.7.4'];
    expect(() => dependencyClosure(broken)).toThrow('/semver@7.7.4');
  });

  it('ignores the scheduling keys of build-desktop but not its steps', () => {
    const job = { 'runs-on': 'x', needs: 'version', steps: [{ run: 'electron-builder --mac' }] };
    const plain = buildJob({ jobs: { 'build-desktop': job } });
    expect(buildJob({ jobs: { 'build-desktop': { ...job, needs: ['version', 'desktop-plan'], if: 'true' } } })).toBe(plain);
    expect(buildJob({ jobs: { 'build-desktop': { ...job, steps: [{ run: 'electron-builder --win' }] } } })).not.toBe(plain);
  });

  it('hashes the packaged sources and leaves out tests and docs', () => {
    const files = sourceFiles(root).map((line) => line.split(' ')[2]);
    expect(files).toContain('apps/desktop-electron/src/main.js');
    expect(files).toContain('apps/desktop-electron/electron-builder.yml');
    expect(files).toContain('packages/agent-tunnel/src/agent/cli.ts');
    expect(files.filter((f) => /\.test\.|README\.md$/.test(f))).toEqual([]);
  });
});

describe('deploy-prod desktop wiring', () => {
  it('builds desktop installers only when desktop-plan asks for a build', () => {
    expect(workflow).toMatch(
      /\n {2}build-desktop:\n[^\n]*\n {4}needs: \[version, desktop-plan\]\n {4}if: needs\.desktop-plan\.outputs\.build == 'true'\n/,
    );
  });

  it('records the fingerprint on every release that gets installers', () => {
    const attach = workflow.slice(workflow.indexOf('\n  attach-desktop:\n'), workflow.indexOf('\n  attach-capture:\n'));
    expect(attach).toContain('> DESKTOP-FINGERPRINT');
    expect(attach).toContain('--pattern DESKTOP-FINGERPRINT');
    expect(attach).toContain('sha256sum -c DESKTOP-SHA256SUMS');
  });
});
