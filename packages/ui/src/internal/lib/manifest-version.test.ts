import { describe, expect, test } from 'bun:test';

import { detectManifestVersion, manifestFilename, manifestNeedsUpgrade, type ManifestVersion } from './manifest-version';

describe('detectManifestVersion', () => {
  test('TOML v1 manifest ("kortix_version = 1")', () => {
    expect(detectManifestVersion('kortix_version = 1\n\n[project]\nname = "x"\n')).toBe(1);
  });

  test('YAML v2 manifest ("kortix_version: 2")', () => {
    expect(detectManifestVersion('kortix_version: 2\ndefault_agent: kortix\n')).toBe(2);
  });

  test('YAML v1 manifest is still v1 (dual-format v1 is legal)', () => {
    expect(detectManifestVersion('kortix_version: 1\n')).toBe(1);
  });

  test('quoted version value', () => {
    expect(detectManifestVersion('kortix_version: "2"\n')).toBe(2);
  });

  test('missing manifest text defaults to v1', () => {
    expect(detectManifestVersion(null)).toBe(1);
    expect(detectManifestVersion(undefined)).toBe(1);
    expect(detectManifestVersion('')).toBe(1);
  });

  test('manifest text with no kortix_version line defaults to v1', () => {
    expect(detectManifestVersion('[project]\nname = "x"\n')).toBe(1);
  });

  test('YAML v3 manifest ("kortix_version: 3")', () => {
    expect(detectManifestVersion('kortix_version: 3\ndefault_agent: kortix\n')).toBe(3);
  });

  test('a version beyond 3 reads as v3 (the newest this client knows)', () => {
    expect(detectManifestVersion('kortix_version: 4\n')).toBe(3);
  });
});

describe('manifestFilename', () => {
  test('v1 and an unresolved read name kortix.toml; v2 and v3 name kortix.yaml', () => {
    expect([1, 2, 3, null].map(manifestFilename)).toEqual([
      'kortix.toml',
      'kortix.yaml',
      'kortix.yaml',
      'kortix.toml',
    ]);
  });
});

describe('manifestNeedsUpgrade', () => {
  test('only a v1 project is offered an upgrade; v3 is opt-in', () => {
    expect([1, 2, 3, null].map((v) => manifestNeedsUpgrade(v as ManifestVersion | null))).toEqual([true, false, false, false]);
  });
});
