import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { VOXL_SHA256_AMD64, VOXL_SHA256_ARM64 } from '../../runtime-versions';
import {
  KORTIX_LOGO_PATHS,
  KORTIX_SYMBOL_PATH,
  SANDBOX_DESKTOP_FILES,
  SANDBOX_DESKTOP_INSTALL_COMMAND,
  SANDBOX_DESKTOP_PACKAGES,
} from '../desktop';
import { kortixToolchainLayer } from '../dockerfile-layer';

const repoFile = (path: string) =>
  readFileSync(resolve(import.meta.dir, '../../../../..', path), 'utf8');

// The meta-agent image is a coordinator with no desktop, on purpose.
const IMAGES = [
  {
    label: 'standard layer (platform default + custom templates)',
    dockerfile: kortixToolchainLayer({}),
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

  test('draws the logo and symbol from the brand kit master files', () => {
    const paths = (file: string) => [...repoFile(file).matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect([...KORTIX_LOGO_PATHS]).toEqual(paths('apps/web/public/brandkit/Logo/Logomark/SVG/Logomark White.svg'));
    expect([KORTIX_SYMBOL_PATH]).toEqual(paths('apps/web/public/brandkit/Logo/Brandmark/SVG/Brandmark White.svg'));
  });

  test('writes every look file, each a well-formed document', () => {
    for (const [path, body] of Object.entries(SANDBOX_DESKTOP_FILES)) {
      expect(SANDBOX_DESKTOP_INSTALL_COMMAND).toContain(`printf %s ${btoa(body)} | base64 -d > ${path}`);
      if (/\.(xml|svg)$/.test(path)) {
        const tags = [...body.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)].filter((m) => !m[3]);
        const depth = tags.reduce((d, m) => d + (m[1] ? -1 : 1), 0);
        expect(depth).toBe(0);
      }
    }
  });
});
