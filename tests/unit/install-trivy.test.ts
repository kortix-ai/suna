import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/fixtures/repo';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('installs the pinned binary through the real checksum-verifying upstream installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'trivy-install-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const result = spawnSync('bash', [join(REPO_ROOT, 'infra/scripts/install-trivy.sh'), bin], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(execFileSync(join(bin, 'trivy'), ['--version'], { encoding: 'utf8' })).toContain('Version: 0.70.0');
}, 60_000);

it('fails closed when the downloaded installer checksum does not match', () => {
  const root = mkdtempSync(join(tmpdir(), 'trivy-tamper-'));
  roots.push(root);
  mkdirSync(join(root, 'tools'));
  // Only replace the HTTP boundary; the installation script and hash check are real.
  writeFileSync(join(root, 'tools/curl'), '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n if [[ "$1" == --output ]]; then printf "exit 0\\n" > "$2"; exit 0; fi\n shift\ndone\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('bash', [join(REPO_ROOT, 'infra/scripts/install-trivy.sh'), join(root, 'bin')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}` },
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('FAILED');
});
