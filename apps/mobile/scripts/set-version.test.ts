import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readVersions, setVersion, VERSION_SITES } from './set-version.mjs';

const MOBILE = join(import.meta.dir, '..');

describe('app version', () => {
  test('every native copy carries the same version and runtimeVersion', () => {
    const found = readVersions();
    // Each site matched at least once: a renamed key must not drop out silently.
    expect(new Set(found.map((f) => f.file)).size).toBe(new Set(VERSION_SITES.map(([file]) => file)).size);
    expect(found.length).toBeGreaterThanOrEqual(VERSION_SITES.length);
    expect(new Set(found.map((f) => f.version))).toEqual(new Set([found[0].version]));
  });

  test('setVersion rewrites every site and rejects a non-semver value', () => {
    const root = mkdtempSync(join(tmpdir(), 'mobile-version-'));
    for (const [file] of VERSION_SITES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(MOBILE, file), join(root, file));
    }

    setVersion('9.8.7', root);
    expect(new Set(readVersions(root).map((f) => f.version))).toEqual(new Set(['9.8.7']));
    expect(() => setVersion('1.5', root)).toThrow('MAJOR.MINOR.PATCH');
  });
});
