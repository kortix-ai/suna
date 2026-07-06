import { describe, expect, test } from 'bun:test';

import { detectManifestVersion } from './manifest-version';

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

  test('a version beyond 2 still reads as v2 (never-v1) for UI purposes', () => {
    expect(detectManifestVersion('kortix_version: 3\n')).toBe(2);
  });
});
