import { describe, expect, test } from 'bun:test';

import { formatSize, pickCliAsset, pickDesktopAsset, type ReleaseAsset } from './releases';

/** Mirrors the real v0.11.0 asset list, including the decoys. */
const ASSETS: ReleaseAsset[] = [
  { name: 'dosco-0.11.0-universal-mac.zip', url: 'u/zip', size: 197_650_000 },
  { name: 'dosco-0.11.0-universal.dmg', url: 'u/dmg', size: 204_800_000 },
  { name: 'dosco-0.11.0-universal.dmg.blockmap', url: 'u/dmg.blockmap', size: 210_000 },
  { name: 'dosco-0.11.0-x86_64.AppImage', url: 'u/appimage', size: 115_900_000 },
  { name: 'kortix-darwin-arm64', url: 'u/cli-darwin-arm64', size: 69_700_000 },
  { name: 'kortix-darwin-x64', url: 'u/cli-darwin-x64', size: 75_400_000 },
  { name: 'kortix-linux-arm64', url: 'u/cli-linux-arm64', size: 99_900_000 },
  { name: 'kortix-linux-x64', url: 'u/cli-linux-x64', size: 100_800_000 },
  { name: 'dosco-Setup-0.11.0.exe', url: 'u/exe', size: 96_000_000 },
  { name: 'dosco-Setup-0.11.0.exe.blockmap', url: 'u/exe.blockmap', size: 100_000 },
  { name: 'latest-mac.yml', url: 'u/yml', size: 1_000 },
  { name: 'SHA256SUMS', url: 'u/sums', size: 900 },
];

describe('pickDesktopAsset', () => {
  test('picks the installer for each platform', () => {
    expect(pickDesktopAsset(ASSETS, 'macos')?.url).toBe('u/dmg');
    expect(pickDesktopAsset(ASSETS, 'windows')?.url).toBe('u/exe');
    expect(pickDesktopAsset(ASSETS, 'linux')?.url).toBe('u/appimage');
  });

  test('never returns a .blockmap, .zip, .yml, or checksum file', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      const name = pickDesktopAsset(ASSETS, os)?.name ?? '';
      expect(name).not.toContain('.blockmap');
      expect(name.endsWith('.zip')).toBe(false);
      expect(name.endsWith('.yml')).toBe(false);
      expect(name).not.toBe('SHA256SUMS');
    }
  });

  test('prefers the universal .dmg when per-arch builds also exist', () => {
    // Guards the historical Intel-download bug: never blindly take the first .dmg.
    const perArch: ReleaseAsset[] = [
      { name: 'dosco-9.0.0-x64.dmg', url: 'u/intel', size: 1 },
      { name: 'dosco-9.0.0-universal.dmg', url: 'u/universal', size: 2 },
      { name: 'dosco-9.0.0-arm64.dmg', url: 'u/arm', size: 3 },
    ];
    expect(pickDesktopAsset(perArch, 'macos')?.url).toBe('u/universal');
  });

  test('returns undefined when the platform has no installer', () => {
    expect(pickDesktopAsset([], 'macos')).toBeUndefined();
    expect(pickDesktopAsset([{ name: 'notes.txt', url: 'u/t', size: 1 }], 'linux')).toBeUndefined();
  });
});

describe('pickCliAsset', () => {
  test('matches the binary for the platform and architecture', () => {
    expect(pickCliAsset(ASSETS, 'macos', 'arm64')?.url).toBe('u/cli-darwin-arm64');
    expect(pickCliAsset(ASSETS, 'macos', 'x64')?.url).toBe('u/cli-darwin-x64');
    expect(pickCliAsset(ASSETS, 'linux', 'arm64')?.url).toBe('u/cli-linux-arm64');
    expect(pickCliAsset(ASSETS, 'linux', 'x64')?.url).toBe('u/cli-linux-x64');
  });

  test('returns undefined for Windows because no Windows CLI binary is published', () => {
    expect(pickCliAsset(ASSETS, 'windows', 'x64')).toBeUndefined();
    expect(pickCliAsset(ASSETS, 'windows', 'arm64')).toBeUndefined();
  });
});

describe('formatSize', () => {
  test('renders whole megabytes', () => {
    expect(formatSize(204_800_000)).toBe('195 MB');
    expect(formatSize(96_000_000)).toBe('92 MB');
  });

  test('returns an empty string for a missing or zero size', () => {
    expect(formatSize(0)).toBe('');
  });
});
