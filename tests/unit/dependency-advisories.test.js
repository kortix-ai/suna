import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// KRTX-3420: every resolved release of these packages includes its advisory fix.
// Lockfiles are the shipped dependency inventory, including transitive copies.
const FIXED = {
  // GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w (address parsing misdelivery)
  nodemailer: '>=10.1.4',
  // GHSA-mrhx-c7xc-m3w5 (unbounded issue accumulation). zod 3 is affected too but has
  // no fixed 3.x release: a documented exception (.trivyignore, pnpm.auditConfig).
  zod: '<4 || >=4.6.6',
  // GHSA-86w9-cpqp-85rv (PKCS#1 v1.5 verification)
  'node-forge': '>=1.4.1',
  // GHSA-27r3-jxmh-p828 (DoS on trailing bytes after a compressed body)
  'body-parser': '>=2.4.0',
  // GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr (scheme spoofing, host confusion)
  'fast-uri': '>=3.1.9',
  // GHSA-834v-8h66-3h79 (import alias host code execution; test-only)
  'happy-dom': '>=21.0.4',
  // GHSA-rj75-hqrm-r3gf (quadratic selector parsing)
  'postcss-selector-parser': '>=6.1.5',
};

function resolved(keys, name, prefix) {
  return keys
    .filter((key) => key.startsWith(`${prefix}${name}@`))
    .map((key) => key.slice(`${prefix}${name}@`.length).split('(')[0]);
}

test('the workspace lockfile resolves every advisory package at its fixed version', () => {
  const lock = Bun.YAML.parse(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'));
  const keys = Object.keys(lock.packages);
  for (const [name, range] of Object.entries(FIXED)) {
    const versions = resolved(keys, name, '/');
    expect(versions.length, name).toBeGreaterThan(0);
    for (const version of versions) expect(Bun.semver.satisfies(version, range), `${name}@${version}`).toBe(true);
  }
});

test('the independently installed daemon lockfile resolves node-forge at its fixed version', () => {
  const lock = Bun.JSONC.parse(readFileSync(new URL('../../apps/kortix-sandbox-agent-server/bun.lock', import.meta.url), 'utf8'));
  const versions = Object.values(lock.packages)
    .map((entry) => entry[0])
    .filter((id) => id.startsWith('node-forge@'))
    .map((id) => id.slice('node-forge@'.length));
  expect(versions.length).toBeGreaterThan(0);
  for (const version of versions) expect(Bun.semver.satisfies(version, FIXED['node-forge']), version).toBe(true);
});

test('the scanner workspace and the OpenCode template resolve zod 4 at its fixed version', () => {
  const scanner = Bun.YAML.parse(readFileSync(new URL('../../.deepsec/pnpm-lock.yaml', import.meta.url), 'utf8'));
  const template = Bun.JSONC.parse(
    readFileSync(new URL('../../packages/starter/templates/base/harnesses/opencode/bun.lock', import.meta.url), 'utf8'),
  );
  const versions = [
    ...resolved(Object.keys(scanner.packages), 'zod', ''),
    ...Object.values(template.packages).map((entry) => entry[0]).filter((id) => id.startsWith('zod@')).map((id) => id.slice(4)),
  ];
  expect(versions.length).toBeGreaterThan(0);
  for (const version of versions) expect(Bun.semver.satisfies(version, FIXED.zod), `zod@${version}`).toBe(true);
});
