import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPENCODE_VERSION } from '../../runtime-versions';
import { kortixToolchainLayer } from '../dockerfile-layer';

describe('workspace search executable in environment images', () => {
  const images = {
    'shared and custom template layer': kortixToolchainLayer({
      opencodeVersion: OPENCODE_VERSION,
    }),
    'standalone sandbox': readFileSync(
      resolve(import.meta.dir, '../../../../../apps/sandbox/Dockerfile'),
      'utf8',
    ),
  };

  for (const [name, dockerfile] of Object.entries(images)) {
    test(`${name} installs and checks the executable used by Pi glob and grep`, () => {
      const packages = dockerfile.match(/apt-get install -y --no-install-recommends ([\s\S]*?)&&/);
      expect(packages?.[1]).toMatch(/\bripgrep\b/);
      expect(dockerfile).toContain('&& rg --version');
    });
  }
});
