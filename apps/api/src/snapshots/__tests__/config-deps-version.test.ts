import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_VERSION } from '@kortix/shared';

// Version-drift guard for the OpenCode config-dir plugin pin.
//
// OpenCode loads the plugin SDK (@opencode-ai/plugin) that matches its OWN binary
// version: at session boot it overwrites whatever the config dir pins and fetches
// the binary-matching version over the network if it isn't already present. The
// snapshot bake (dockerfile-layer.ts / warm-bake.ts) therefore pins the baked
// @opencode-ai/plugin to OPENCODE_VERSION so opencode finds it already installed
// and skips that boot-time network fetch (the multi-second "opencode-session-
// created" stall).
//
// For that to hold, the STARTER template every project clones must pin the SAME
// version — otherwise a freshly-scaffolded project carries a mismatched pin again.
// This test fails the build whenever an opencode bump in runtime-versions.json
// isn't mirrored into the starter template, keeping the two in lockstep forever.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');
const STARTER_CONFIG_PKG = resolve(
  REPO_ROOT,
  'packages/starter/templates/base/.kortix/opencode/package.json',
);

describe('opencode config-dir plugin version', () => {
  test('starter @opencode-ai/plugin pin matches the opencode binary version', () => {
    const pkg = JSON.parse(readFileSync(STARTER_CONFIG_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const pinned = pkg.dependencies?.['@opencode-ai/plugin'];
    expect(pinned).toBe(OPENCODE_VERSION);
  });

  test('the pin is an exact version, not a range or dist tag', () => {
    const pkg = JSON.parse(readFileSync(STARTER_CONFIG_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@opencode-ai/plugin']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
