/**
 * Every image fingerprint that hashes the daemon's source also hashes its
 * build script. `scripts/build.sh` holds the compile flags: `--bytecode
 * --format=esm` changed the binary (109,557,728 to 138,217,440 bytes, exec to
 * `main()` ~540 to ~220 ms) with no source change, and both the session
 * templates and the My Kortix image kept booting the old binary (PR #11611
 * preview, 2026-11-03). The API image must carry the file: a missing
 * fingerprint input fails every template listing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNTIME_ARTIFACTS } from './templates';
import { metaRuntimeArtifacts } from './runtime-images';

const repoRoot = resolve(import.meta.dir, '../../../..');
const DAEMON_SRC = resolve(repoRoot, 'apps/kortix-sandbox-agent-server/src');
const DAEMON_BUILD = resolve(repoRoot, 'apps/kortix-sandbox-agent-server/scripts/build.sh');

describe('image fingerprints follow the daemon build script', () => {
  const sets = [
    { name: 'session templates', artifacts: RUNTIME_ARTIFACTS },
    { name: 'My Kortix image', artifacts: metaRuntimeArtifacts(repoRoot) },
  ];
  for (const { name, artifacts } of sets) {
    test(`${name}: hashes the daemon source and its build script`, () => {
      const paths = artifacts.map((artifact) => artifact.path);
      expect(paths).toContain(DAEMON_SRC);
      expect(paths).toContain(DAEMON_BUILD);
    });
  }

  test('the build script exists where the fingerprints read it', () => {
    expect(existsSync(DAEMON_BUILD)).toBe(true);
  });
});
