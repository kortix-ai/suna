import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// KRTX-3420: every resolved release of these packages includes its advisory fix.
// Lockfiles are the shipped dependency inventory, including transitive copies.
// Not here: happy-dom (test-only, GHSA-834v-8h66-3h79; a 20 -> 21 major on its
// own PR) and the starter template's zod 4.1.8 pin, which ships to sandboxes
// with OpenCode's pty plugin and sees no untrusted input.
const FIXED = {
  // GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w (address parsing misdelivery)
  nodemailer: '>=10.1.4',
  // GHSA-mrhx-c7xc-m3w5 (unbounded issue accumulation); zod 3 is not affected
  zod: '<4 || >=4.6.6',
  // GHSA-86w9-cpqp-85rv (PKCS#1 v1.5 verification)
  'node-forge': '>=1.4.1',
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
