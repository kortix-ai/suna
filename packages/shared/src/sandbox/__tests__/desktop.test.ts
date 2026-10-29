import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { OPENCODE_VERSION, VOXL_SHA256_AMD64, VOXL_SHA256_ARM64 } from '../../runtime-versions';
import { SANDBOX_DESKTOP_INSTALL_COMMAND, SANDBOX_DESKTOP_PACKAGES } from '../desktop';
import { kortixToolchainLayer } from '../dockerfile-layer';

const repoFile = (path: string) =>
  readFileSync(resolve(import.meta.dir, '../../../../..', path), 'utf8');

// The meta-agent image is a coordinator with no desktop, on purpose.
const IMAGES = [
  {
    label: 'standard layer (platform default + custom templates)',
    dockerfile: kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION }),
  },
  { label: 'apps/sandbox/Dockerfile', dockerfile: repoFile('apps/sandbox/Dockerfile') },
];

describe('session desktop', () => {
  for (const { label, dockerfile } of IMAGES) {
    test(`${label} installs it verbatim`, () => {
      expect(dockerfile).toContain(`RUN ${SANDBOX_DESKTOP_INSTALL_COMMAND}\n`);
    });
  }

  test('pins both voxl binaries by sha256', () => {
    for (const sha of [VOXL_SHA256_AMD64, VOXL_SHA256_ARM64]) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(SANDBOX_DESKTOP_INSTALL_COMMAND).toContain(sha);
    }
  });

  test('skips a non-24.04 base instead of failing its build, and links kortix-desktop', () => {
    expect(SANDBOX_DESKTOP_INSTALL_COMMAND).toContain('if apt-cache show libx264-164 libyuv0');
    expect(SANDBOX_DESKTOP_INSTALL_COMMAND).toContain('ln -sf /usr/local/bin/kortix-entrypoint /usr/local/bin/kortix-desktop');
    expect([...SANDBOX_DESKTOP_PACKAGES]).toEqual([...SANDBOX_DESKTOP_PACKAGES].sort());
    // E2B's Dockerfile parser cannot read heredocs or newlines.
    expect(SANDBOX_DESKTOP_INSTALL_COMMAND).not.toContain('<<');
    expect(SANDBOX_DESKTOP_INSTALL_COMMAND).not.toContain('\n');
  });
});
